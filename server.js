const express = require('express');
const axios = require('axios');
const cookie = require('cookie');
const crypto = require('crypto');
const querystring = require('querystring');
const nonce = require('nonce')();
const request = require('request-promise');
const { Shopify } = require('@shopify/shopify-api');
const Bottleneck = require('bottleneck');
const NodeCache = require('node-cache');
const accessTokenCache = new NodeCache(); // No TTL by default

const shippo = require('shippo')(process.env.SHIPPO_API_KEY);

require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let accessTokenStore = {}; // In-memory store

app.get('/shopify', (req, res) => {
  const shop = req.query.shop;
  if (shop) {
    const state = nonce();
    const redirectUri = 'https://ts-shipping-calculator-ab26e219466a.herokuapp.com/shopify/callback';
    const installUrl = 'https://' + shop + '/admin/oauth/authorize?client_id=' + process.env.SHOPIFY_API_KEY +
      '&scope=write_shipping,read_products,write_products' +
      '&state=' + state +
      '&redirect_uri=' + redirectUri;

    res.cookie('state', state);
    res.redirect(installUrl);
  } else {
    return res.status(400).send("Missing shop parameter.");
  }
});

app.get('/shopify/callback', (req, res) => {
  const { shop, hmac, code, state } = req.query;
  const cookies = req.headers.cookie ? cookie.parse(req.headers.cookie) : {};
  const stateCookie = cookies.state;

  if (state !== stateCookie) {
    return res.status(403).send('Request origin cannot be verified');
  }

  if (shop && hmac && code) {
    const map = { ...req.query };
    delete map['hmac'];
    const message = querystring.stringify(map);
    const generatedHash = crypto.createHmac('sha256', process.env.SHOPIFY_API_SECRET).update(message).digest('hex');

    if (generatedHash !== hmac) {
      return res.status(400).send('HMAC validation failed');
    }

    const accessTokenRequestUrl = `https://${shop}/admin/oauth/access_token`;
    const accessTokenPayload = {
      client_id: process.env.SHOPIFY_API_KEY,
      client_secret: process.env.SHOPIFY_API_SECRET,
      code
    };

    request.post(accessTokenRequestUrl, { json: accessTokenPayload })
      .then(async (accessTokenResponse) => {
        const accessToken = accessTokenResponse.access_token;

         // Store the access token in node-cache without expiration
        accessTokenCache.set('AccessToken', accessToken, 0); // 0 means no expiration
        accessTokenCache.set('Shop', shop, 0); // 0 means no expiration

        console.log("SHOP: " + shop);
        console.log("Access-Token: " + accessToken);

        const carrierServiceRequestUrl = `https://${shop}/admin/carrier_services.json`;
        const carrierServicePayload = {
          carrier_service: {
            name: "Custom Shipping Rate Calculator",
            callback_url: "https://ts-shipping-calculator-ab26e219466a.herokuapp.com/shopify/rate",
            service_discovery: true
          }
        };

        const apiRequestHeader = {
          'X-Shopify-Access-Token': accessToken,
          'Content-Type': 'application/json'
        };

        try {
          await request.post(carrierServiceRequestUrl, {
            headers: apiRequestHeader,
            json: carrierServicePayload
          });
          console.log('Carrier service created successfully');
        } catch (error) {
          console.error('Error creating carrier service:', error.response ? error.response.data : error.message);
        }

        res.send('App installed');
      })
      .catch((error) => {
        res.status(error.statusCode).send(error.error.error_description);
      });

  } else {
    res.status(400).send('Required parameters missing');
  }
});

app.post('/shopify/rate', async (req, res) => {
  const { rate } = req.body;
  const { origin, destination, items, currency, locale } = rate;


  const accessToken = accessTokenCache.get('AccessToken');
  const shop = accessTokenCache.get('Shop');


  console.log("Shop: " + shop);
  console.log("Token: " + accessToken);

  if (!accessToken) {
    return res.status(403).send('Access token not found for the shop');
  }

  const apiRequestHeader = {
    'X-Shopify-Access-Token': accessToken,
    'Content-Type': 'application/json'
  };

  try {
    const shopResponse = await axios.get(`https://${shop}/admin/api/2023-10/shop.json`, {
      headers: apiRequestHeader
    });
    console.log('Shop Info:', shopResponse.data);

    const metafieldsPromises = items.map(async (item) => {
      const productId = item.product_id;
      try {
        const metafieldsResponse = await axios.get(`https://${shop}/admin/api/2023-10/products/${productId}/metafields.json`, {
          headers: apiRequestHeader
        });

        console.log(`Metafields response for product ${productId}:`, metafieldsResponse.data);

        const metafields = metafieldsResponse.data.metafields;
        const itemMetafields = {};

        metafields.forEach((metafield) => {
          const key = `${metafield.namespace}.${metafield.key}`;
          if (['global.oversized', 'global.free_shipping', 'global.free_ship_discount', 'custom.height', 'custom.width', 'custom.length'].includes(key)) {
            itemMetafields[key] = metafield.value;
          }
        });

        return { ...item, metafields: itemMetafields };
      } catch (error) {
        console.error(`Error retrieving metafields for product ${productId}:`, error.response ? error.response.data : error.message);
        return { ...item, metafields: {} };
      }
    });

    const itemsWithMetafields = await Promise.all(metafieldsPromises);
    console.log('Items with Metafields:', itemsWithMetafields);

    let totalOrder = 0;
    const freeShipOver = 29900;
    let oversizedItem = false;
    let hasFreeShippingItems = false;
    let hasNonFreeShippingItems = false;

    itemsWithMetafields.forEach(item => {
      totalOrder += item.price * item.quantity;
    });

    let weight = 0;
    let freeShipping = false;
    let commonProductExists = false;

    //Checking for oversized & free shipping
    itemsWithMetafields.forEach(item => {
      const metafields = item.metafields;
      const height = metafields['custom.height'] ? JSON.parse(metafields['custom.height']).value : null;
      const length = metafields['custom.length'] ? JSON.parse(metafields['custom.length']).value : null;
      const width = metafields['custom.width'] ? JSON.parse(metafields['custom.width']).value : null;
      const oversized = metafields['global.oversized'] ? JSON.parse(metafields['global.oversized']) : null;
      const freeShipping = metafields['global.free_shipping'] ? JSON.parse(metafields['global.free_shipping']) : null;
      const freeShipOverSized = metafields['global.free_ship_discount'] ? JSON.parse(metafields['global.free_ship_discount']) : null;

      if (oversized) {
        oversizedItem = true;
      } 

      if (freeShipping || freeShipOverSized) {
        hasFreeShippingItems = true;
      } else {
          hasNonFreeShippingItems = true;
          weight += item.grams * item.quantity;
      }
    });

    weight *= 0.00220462; // Convert grams to pounds

    const addressFrom = {
      name: shopResponse.data.shop.name,
      street1: origin.address1,
      city: origin.city,
      state: origin.province,
      zip: origin.postal_code,
      country: origin.country
    };
    console.log('Address From:', addressFrom);

    const addressTo = {
      name: destination.name,
      street1: destination.address1,
      city: destination.city,
      state: destination.province,
      zip: destination.postal_code,
      country: destination.country
    };
    console.log('Address To:', addressTo);

    let parcels = itemsWithMetafields
    .filter(item => {
      const metafields = item.metafields;
      const freeShipping = metafields['global.free_shipping'] ? JSON.parse(metafields['global.free_shipping']) : false;
      const freeShipOverSized = metafields['global.free_ship_discount'] ? JSON.parse(metafields['global.free_ship_discount']) : false;
      return !freeShipping && !freeShipOverSized;
    })
    .map(item => {
      const metafields = item.metafields;
      return {
        length: metafields['custom.length'] ? JSON.parse(metafields['custom.length']).value : 10,
        width: metafields['custom.width'] ? JSON.parse(metafields['custom.width']).value : 10,
        height: metafields['custom.height'] ? JSON.parse(metafields['custom.height']).value : 10,
        distance_unit: 'in',
        weight: item.grams * 0.00220462, // Shippo expects weight in pounds
        mass_unit: 'lb'
      };
    });
    console.log('Parcels:', parcels);

    let rates;
    let calculatedRates = [];
    if (parcels.length > 0) {
      const shipment = await shippo.shipment.create({
        address_from: addressFrom,
        address_to: addressTo,
        parcels: parcels,
        async: false
      });
      console.log('Shipment:', shipment);

      rates = shipment.rates;
      console.log('Rates:', rates);

      calculatedRates = rates.map(rate => ({
        "service_name": oversizedItem ? `${rate.servicelevel.name} - Oversized Item Included, shipping rates may change on fullfillment` : rate.servicelevel.name,
        "service_code": rate.servicelevel.token,
        "total_price": (parseFloat(rate.amount) * 100).toFixed(0), // converting to cents
        "currency": rate.currency,
        "min_delivery_date": rate.estimated_days ? new Date(Date.now() + rate.estimated_days * 24 * 60 * 60 * 1000).toISOString() : undefined,
        "max_delivery_date": rate.estimated_days ? new Date(Date.now() + (rate.estimated_days + 2) * 24 * 60 * 60 * 1000).toISOString() : undefined,
        "description": rate.provider
      }));
    }

    if (hasFreeShippingItems && !hasNonFreeShippingItems) {
      calculatedRates.push({
        service_name: "Free Shipping",
        service_code: "free_shipping",
        total_price: "0",
        currency: "USD",
        min_delivery_date: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
        max_delivery_date: new Date(Date.now() + 4 * 24 * 60 * 60 * 1000).toISOString(),
        description: "All items are eligible for free shipping"
      });
    }

    console.log('Calculated Rates:', calculatedRates);

    let response = {
      rates: calculatedRates
    };

    res.json(response);
  } catch (error) {
    console.error('Error retrieving shop info:', error.response ? error.response.data : error.message);
    res.status(500).send('Error retrieving shop info');
  }
});

app.listen(PORT, () => {
  console.log(`App running on port ${PORT}`);
});

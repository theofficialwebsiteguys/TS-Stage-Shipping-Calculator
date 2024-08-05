const express = require('express');
const axios = require('axios');
const cookie = require('cookie');
const crypto = require('crypto');
const querystring = require('querystring');
const nonce = require('nonce')();
const request = require('request-promise');
const { Shopify } = require('@shopify/shopify-api');
const Bottleneck = require('bottleneck');

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
  const stateCookie = cookie.parse(req.headers.cookie).state;

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

        // Store the access token in the in-memory store
        accessTokenStore[shop] = accessToken;

        console.log("SHOP: " + shop);
        console.log("Access-Token1: " + accessTokenStore[shop]);

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

        // Initialize the rate limiter
        const limiter = new Bottleneck({
          minTime: 500 // 2 requests per second
        });

        // Function to create a single metafield
        const createMetafield = async (productId, metafield) => {
          try {
            await axios.post(`https://${shop}/admin/api/2023-10/products/${productId}/metafields.json`, { metafield }, {
              headers: apiRequestHeader
            });
            console.log(`Metafield ${metafield.key} created for product ${productId}`);
          } catch (error) {
            console.error(`Error creating metafield ${metafield.key} for product ${productId}:`, error.response ? error.response.data : error.message);
          }
        };

        // Function to create all metafields for a product
        const createAllMetafields = async (productId) => {
          const metafieldsPayloads = [
            {
              namespace: 'global',
              key: 'oversized',
              value: 'false',
              type: 'single_line_text_field'
            },
            {
              namespace: 'global',
              key: 'free_shipping',
              value: 'false',
              type: 'single_line_text_field'
            },
            {
              namespace: 'global',
              key: 'free_ship_discount',
              value: 'false',
              type: 'single_line_text_field'
            }
          ];

          const metafieldPromises = metafieldsPayloads.map(metafield => createMetafield(productId, metafield));
          await Promise.all(metafieldPromises);
        };

        // Get all products and create metafields for each product
        try {
          const productsResponse = await axios.get(`https://${shop}/admin/api/2023-10/products.json`, {
            headers: apiRequestHeader
          });

          const products = productsResponse.data.products;

          console.log(products);

          const metafieldPromises = products.map(product => limiter.schedule(() => createAllMetafields(product.id)));

          await Promise.all(metafieldPromises);
          console.log('Metafields created successfully for all products');
        } catch (error) {
          console.error('Error retrieving products:', error.response ? error.response.data : error.message);
        }

        res.send('App installed and metafields created successfully');
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

  const shop = 'ts-stage-testing.myshopify.com'; // You should retrieve this dynamically if needed
  const accessToken = accessTokenStore[shop]; // Retrieve the access token from the store

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

    const metafieldsPromises = items.map(async (item) => {
      const productId = item.product_id;
      try {
        const metafieldsResponse = await axios.get(`https://${shop}/admin/api/2023-10/products/${productId}/metafields.json`, {
          headers: apiRequestHeader
        });

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
        return { ...item, metafields: {} };
      }
    });

    const itemsWithMetafields = await Promise.all(metafieldsPromises);

    let totalOrder = 0;
    const freeShipOver = 29900;

    itemsWithMetafields.forEach(item => {
      totalOrder += item.price * item.quantity;
    });

    let weight = 0;
    let freeShipping = false;
    let oversizedExists = false;
    let commonProductExists = false;

    itemsWithMetafields.forEach(item => {
      const metafields = item.metafields;
      const height = metafields['custom.height'] ? JSON.parse(metafields['custom.height']) : null;
      const length = metafields['custom.length'] ? JSON.parse(metafields['custom.length']) : null;
      const width = metafields['custom.width'] ? JSON.parse(metafields['custom.width']) : null;
      const oversized = metafields['global.oversized'] ? JSON.parse(metafields['global.oversized']) : null;
      const freeShipping = metafields['global.free_shipping'] ? JSON.parse(metafields['global.free_shipping']) : null;
      const freeShipOverSized = metafields['global.free_ship_discount'] ? JSON.parse(metafields['global.free_ship_discount']) : null;

      if (oversized) {
        oversizedExists = true;
      } else if (freeShipping || freeShipOverSized) {
        if (totalOrder >= freeShipOver) {
          freeShipping = true;
        } else {
          if (item.requires_shipping) {
            commonProductExists = true;
            weight += item.grams * item.quantity;
          }
        }
      } else {
        if (item.requires_shipping) {
          commonProductExists = true;
          weight += item.grams * item.quantity;
        }
      }
    });

    weight *= 0.00220462; // Convert grams to pounds

    const addressFrom = {
      name: shopResponse.data.name,
      street1: origin.address1,
      city: origin.city,
      state: origin.province,
      zip: origin.postal_code,
      country: origin.country
    };

    const addressTo = {
      name: destination.name,
      street1: destination.address1,
      city: destination.city,
      state: destination.province,
      zip: destination.postal_code,
      country: destination.country
    };

    const parcels = itemsWithMetafields.map(item => ({
      length: item.metafields['custom.length'] || 1,
      width: item.metafields['custom.width'] || 1,
      height: item.metafields['custom.height'] || 1,
      distance_unit: 'in',
      weight: item.grams * 0.00220462, // Shippo expects weight in pounds
      mass_unit: 'lb'
    }));

    const shipment = await shippo.shipment.create({
      address_from: addressFrom,
      address_to: addressTo,
      parcels: parcels,
      async: false
    });

    const rates = shipment.rates;

    if (freeShipping && !commonProductExists) {
      rates.push({
        amount: "0.00",
        provider: "Free Ground Shipping",
        servicelevel: {
          name: "Free Ground Shipping",
          token: "free-ground-shipping"
        },
        estimated_days: 2,
        currency: "USD"
      });
    }

    const calculatedRates = {
      "rates": rates.map(rate => ({
        "service_name": rate.servicelevel.name,
        "service_code": rate.servicelevel.token,
        "total_price": (parseFloat(rate.amount) * 100).toFixed(0), // converting to cents
        "currency": rate.currency,
        "min_delivery_date": rate.estimated_days ? new Date(Date.now() + rate.estimated_days * 24 * 60 * 60 * 1000).toISOString() : undefined,
        "max_delivery_date": rate.estimated_days ? new Date(Date.now() + (rate.estimated_days + 2) * 24 * 60 * 60 * 1000).toISOString() : undefined,
        "description": rate.provider
      }))
    };

    res.json(calculatedRates);
  } catch (error) {
    console.error('Error retrieving shop info:', error.response ? error.response.data : error.message);
    res.status(500).send('Error retrieving shop info');
  }
});

app.listen(PORT, () => {
  console.log(`App running on port ${PORT}`);
});

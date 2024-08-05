const express = require('express');
const axios = require('axios');
const cookie = require('cookie');
const crypto = require('crypto');
const querystring = require('querystring');
const nonce = require('nonce')();
const request = require('request-promise');
const { Shopify } = require('@shopify/shopify-api');
const Shippo = require('shippo');
const { count } = require('console');
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
    const redirectUri = 'https://ts-stage-shipping-400122dbaabe.herokuapp.com/shopify/callback';
    const installUrl = 'https://' + shop + '/admin/oauth/authorize?client_id=' + process.env.SHOPIFY_API_KEY +
      '&scope=write_shipping,read_products' +
      '&state=' + state +
      '&redirect_uri=' + redirectUri;

    res.cookie('state', state);
    res.redirect(installUrl);
  } else {
    return res.status(400).send("Missing shop parameter.");
  }
});

// app.get('/shopify/callback', (req, res) => {
//   const { shop, hmac, code, state } = req.query;
//   const stateCookie = cookie.parse(req.headers.cookie).state;

//   if (state !== stateCookie) {
//     return res.status(403).send('Request origin cannot be verified');
//   }

//   if (shop && hmac && code) {
//     const map = { ...req.query };
//     delete map['hmac'];
//     const message = querystring.stringify(map);
//     const generatedHash = crypto.createHmac('sha256', process.env.SHOPIFY_API_SECRET).update(message).digest('hex');

//     if (generatedHash !== hmac) {
//       return res.status(400).send('HMAC validation failed');
//     }

//     const accessTokenRequestUrl = `https://${shop}/admin/oauth/access_token`;
//     const accessTokenPayload = {
//       client_id: process.env.SHOPIFY_API_KEY,
//       client_secret: process.env.SHOPIFY_API_SECRET,
//       code
//     };

//     request.post(accessTokenRequestUrl, { json: accessTokenPayload })
//       .then((accessTokenResponse) => {
//         const accessToken = accessTokenResponse.access_token;

//         const carrierServiceRequestUrl = `https://${shop}/admin/carrier_services.json`;
//         const carrierServicePayload = {
//           carrier_service: {
//             name: "Custom Shipping Rate Calculator",
//             callback_url: "https://ts-shipping-calculator-ab26e219466a.herokuapp.com/shopify/rate",
//             service_discovery: true
//           }
//         };

//         const apiRequestHeader = {
//           'X-Shopify-Access-Token': accessToken,
//           'Content-Type': 'application/json'
//         };

//         request.post(carrierServiceRequestUrl, {
//           headers: apiRequestHeader,
//           json: carrierServicePayload
//         })
//           .then(() => {
//             res.send('Carrier service created successfully');
//           })
//           .catch((error) => {
//             res.status(error.statusCode).send(error.error.error_description);
//           });

//       })
//       .catch((error) => {
//         res.status(error.statusCode).send(error.error.error_description);
//       });

//   } else {
//     res.status(400).send('Required parameters missing');
//   }
// });

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
      .then((accessTokenResponse) => {
        const accessToken = accessTokenResponse.access_token;

        // Store the access token in the in-memory store
        accessTokenStore[shop] = accessToken;

        console.log("SHOP: " + shop);
        console.log("Access-Token1: " + accessTokenStore[shop]);

        const carrierServiceRequestUrl = `https://${shop}/admin/carrier_services.json`;
        const carrierServicePayload = {
          carrier_service: {
            name: "Custom Shipping Rate Calculator",
            callback_url: "https://ts-stage-shipping-400122dbaabe.herokuapp.com/shopify/rate",
            service_discovery: true
          }
        };

        const apiRequestHeader = {
          'X-Shopify-Access-Token': accessToken,
          'Content-Type': 'application/json'
        };

        request.post(carrierServiceRequestUrl, {
          headers: apiRequestHeader,
          json: carrierServicePayload
        })
          .then(() => {
            res.send('Carrier service created successfully');
          })
          .catch((error) => {
            res.status(error.statusCode).send(error.error.error_description);
          });

      })
      .catch((error) => {
        res.status(error.statusCode).send(error.error.error_description);
      });

  } else {
    res.status(400).send('Required parameters missing');
  }
});

// app.post('/shopify/rate', (req, res) => {
//   const { rate } = req.body;
//   const { origin, destination, items, currency, locale } = rate;

//   console.log("Origin: ", origin);
//   console.log("Destination: ", destination);
//   console.log("Items: ", items);
//   console.log("Currency: ", currency);
//   console.log("Locale: ", locale);

//   // Implement your shipping rate calculation logic here
//   // For demonstration, let's assume we have a simple flat rate calculation

//   const calculatedRate = {
//     "rates": [
//       {
//         "service_name": "Standard Shipping",
//         "service_code": "standard",
//         "total_price": "3000", // Price in cents
//         "description": "Standard Shipping",
//         "currency": "USD",
//         "min_delivery_date": "2024-08-01T14:48:45Z",
//         "max_delivery_date": "2024-08-03T14:48:45Z"
//       }
//     ]
//   };

//   res.json(calculatedRate);
// });


const shippo = Shippo(process.env.SHIPPO_API_KEY);

app.post('/shopify/rate', async (req, res) => {
  const { rate } = req.body;
  const { origin, destination, items, currency, locale } = rate;

  console.log(rate);

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

    console.log('Items with Metafields: ', itemsWithMetafields);

    let totalOrder = 0;
    const freeShipOver = 29900;

    itemsWithMetafields.forEach(item => {
      totalOrder = totalOrder + item.price * item.quantity;
    })

    let weight = 0;
    let freeShipping = false;
    let oversizedExists = false
    let commonProductExists = false

    itemsWithMetafields.forEach(item => {
      const metafields = item.metafields;

      // Check for and parse each metafield
      const height = metafields['custom.height'] ? JSON.parse(metafields['custom.height']) : null;
      const length = metafields['custom.length'] ? JSON.parse(metafields['custom.length']) : null;
      const width = metafields['custom.width'] ? JSON.parse(metafields['custom.width']) : null;
      const oversized = metafields['global.oversized'] ? JSON.parse(metafields['global.oversized']) : null;
      const freeShipping = metafields['global.free_shipping'] ? JSON.parse(metafields['global.free_shipping']) : null;
      const freeShipOverSized = metafields['global.free_ship_discount'] ? JSON.parse(metafields['global.free_ship_discount']) : null;

      // Log the results
      console.log('Item:', item.name);
      if (height) {
        console.log('Height:', height);
      }
      if (length) {
        console.log('Length:', length);
      }
      if (width) {
        console.log('Width:', width);
      }
      if (oversized) {
        oversizedExists = true;
      } else if (freeShipping || freeShipOverSized) {
        if (totalOrder >= freeShipOver) {
          freeShipping = true;
        } else {
          if (item.requires_shipping) {
            commonProductExists = true;
            weight = weight + item.grams * item.quantity;
          }
        }
      } else {
        if (item.requires_shipping) {
          commonProductExists = true;
          weight = weight + item.grams * item.quantity;
        }
      }
    });

    // Converting Grams to LBS

    const conversionFactor = 0.00220462;
    weight = weight * conversionFactor;

    const addressFrom = {
      name: shopResponse.data.name,
      street1: origin.address1,
      city: origin.city,
      state: origin.province,
      zip: origin.postal_code,
      country: origin.country
    }

    const addressTo = {
      name: destination.name,
      street1: destination.address1,
      city: destination.city,
      state: destination.province,
      zip: destination.postal_code,
      country: destination.country
    }

    const parcels = itemsWithMetafields.map(item => ({
      length: item.metafields['custom.length'] || 1,
      width: item.metafields['custom.width'] || 1,
      height: item.metafields['custom.height'] || 1,
      distance_unit: 'in',
      weight: item.grams * conversionFactor, // Shippo expects weight in pounds
      mass_unit: 'lb'
    }));

    const shipment = await shippo.shipment.create({
      address_from: addressFrom,
      address_to: addressTo,
      parcels: parcels,
      async: false
    });


    // Implement your shipping rate calculation logic here using itemsWithMetafields
    // For demonstration, let's assume we have a simple flat rate calculation

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

    if (oversizedExists && !freeShipping && !commonProductExists) {
      rates.push({
        amount: "0.00",
        provider: "Ships via Truck",
        servicelevel: {
          name: "Ships via Truck",
          token: "ships-via-truck"
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

    // if (freeShipping && !commonProductExists) {
    //   calculatedRates = {
    //     "rates": [
    //       {
    //         "service_name": "Free Ground Shipping",
    //         "service_code": "free-ground-shipping",
    //         "total_price": "0", // Price in cents
    //         "description": "'All products in your cart are elligible for free shipping.'",
    //         "currency": "USD",
    //         "min_delivery_date": "2024-08-01T14:48:45Z",
    //         "max_delivery_date": "2024-08-03T14:48:45Z"
    //       }
    //     ]
    //   }
    // }

    // if (oversizedExists && !freeShipping && !commonProductExists) {
    //   calculatedRates = {
    //     "rates": [
    //       {
    //         "service_name": "Ships via Truck",
    //         "service_code": "ships-via-truck",
    //         "total_price": "0", // Price in cents
    //         "description": "Items marked \"Oversized Ships via Truck\" DO NOT SHIP FREE & we will contact you with shipping rate.",
    //         "currency": "USD",
    //         "min_delivery_date": "2024-08-01T14:48:45Z",
    //         "max_delivery_date": "2024-08-03T14:48:45Z"
    //       }
    //     ]
    //   }
    // }

    // calculatedRates = {
    //   "rates": [
    //     {
    //       "service_name": "Standard Shipping",
    //       "service_code": "standard",
    //       "total_price": "50000", // Price in cents
    //       "description": "Standard Shipping",
    //       "currency": "USD",
    //       "min_delivery_date": "2024-08-01T14:48:45Z",
    //       "max_delivery_date": "2024-08-03T14:48:45Z"
    //     }
    //   ]
    // };

    res.json(calculatedRates);
  } catch (error) {
    console.error('Error retrieving shop info:', error.response ? error.response.data : error.message);
    res.status(500).send('Error retrieving shop info');
  }
});


app.listen(PORT, () => {
  console.log(`App running on port ${PORT}`);
});

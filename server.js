const express = require('express');
const axios = require('axios');
const cookie = require('cookie');
const crypto = require('crypto');
const querystring = require('querystring');
const nonce = require('nonce')();
const request = require('request-promise');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/shopify', (req, res) => {
  const shop = req.query.shop;
  if (shop) {
    const state = nonce();
    const redirectUri = 'https://ts-shipping-calculator-ab26e219466a.herokuapp.com/shopify/callback';
    const installUrl = 'https://' + shop + '/admin/oauth/authorize?client_id=' + process.env.SHOPIFY_API_KEY +
      '&scope=write_shipping' +
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
      .then((accessTokenResponse) => {
        const accessToken = accessTokenResponse.access_token;

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

app.post('/shopify/rate', async (req, res) => {
  console.log("Received rate request body:", JSON.stringify(req.body, null, 2));

  const { rate } = req.body;
  if (!rate) {
    return res.status(400).send('Rate information missing');
  }

  const { origin, destination, items, currency, locale } = rate;

  const shop = req.query.shop || req.body.shop;
  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;

  if (!shop || !accessToken) {
    return res.status(400).send('Shop or access token missing');
  }

  console.log("Origin: ", origin);
  console.log("Destination: ", destination);
  console.log("Items: ", items);
  console.log("Currency: ", currency);
  console.log("Locale: ", locale);

  try {
    const itemMetafieldsPromises = items.map(async (item) => {
      const metafieldsUrl = `https://${shop}/admin/api/2021-04/products/${item.product_id}/metafields.json`;
      const metafieldsResponse = await axios.get(metafieldsUrl, {
        headers: {
          'X-Shopify-Access-Token': accessToken
        }
      });
      return {
        item,
        metafields: metafieldsResponse.data.metafields
      };
    });

    const itemsWithMetafields = await Promise.all(itemMetafieldsPromises);

    console.log("Items with Metafields: ", itemsWithMetafields);

    const calculatedRate = {
      "rates": [
        {
          "service_name": "Standard Shipping",
          "service_code": "standard",
          "total_price": "5000",
          "description": "Standard Shipping",
          "currency": "USD",
          "min_delivery_date": "2024-08-01T14:48:45Z",
          "max_delivery_date": "2024-08-03T14:48:45Z"
        }
      ]
    };

    res.json(calculatedRate);

  } catch (error) {
    console.error("Error fetching metafields: ", error);
    res.status(500).send('Error fetching metafields');
  }
});

const server = app.listen(PORT, () => {
  console.log(`App running on port ${PORT}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use`);
    process.exit(1);
  } else {
    throw err;
  }
});

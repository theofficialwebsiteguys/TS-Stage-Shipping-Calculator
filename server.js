const express = require('express');
const axios = require('axios');
const cookie = require('cookie');
const crypto = require('crypto');
const querystring = require('querystring');
const nonce = require('nonce')();
const request = require('request-promise');
const { Shopify } = require('@shopify/shopify-api');
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

// app.get('/shopify/callback', (req, res) => {
//   const { shop, hmac, code, state } = req.query;
//   const stateCookie = cookie.parse(req.headers.cookie).state;

//   console.log("State: " + state);
//   console.log("State Cookie: " + stateCookie);

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

//     const accessTokenRequestUrl = 'https://' + shop + '/admin/oauth/access_token';
//     const accessTokenPayload = {
//       client_id: process.env.SHOPIFY_API_KEY,
//       client_secret: process.env.SHOPIFY_API_SECRET,
//       code
//     };

//     request.post(accessTokenRequestUrl, {json: accessTokenPayload })
//     .then((accessTokenResponse) => {
//       const accessToken = accessTokenResponse.access_token;

//       const apiRequestUrl = 'https://' + shop + '/admin/products.json';
//       const apiRequestHeader = {
//         'X-Shopify-Access-Token' : accessToken
//       }

//       request.get(apiRequestUrl, { headers: apiRequestHeader})
//       .then((apiResponse) => {
//         res.end(apiResponse);
//       })
//       .catch((error) => {
//         res.status(error.statusCode).send(error.error.error_description);
//       })
//     })
//     .catch((error) => {
//       res.status(error.statusCode).send(error.error.error_description);
//     });

//   } else {
//     res.status(400).send('Required parameters missing');
//   }
// });

app.post('/shopify/rate', (req, res) => {
  const { rate } = req.body;
  const { origin, destination, items, currency, locale } = rate;

  console.log("Origin: ", origin);
  console.log("Destination: ", destination);
  console.log("Items: ", items);
  console.log("Currency: ", currency);
  console.log("Locale: ", locale);

  // Implement your shipping rate calculation logic here
  // For demonstration, let's assume we have a simple flat rate calculation

  const calculatedRate = {
    "rates": [
      {
        "service_name": "Standard Shipping",
        "service_code": "standard",
        "total_price": "3000", // Price in cents
        "description": "Standard Shipping",
        "currency": "USD",
        "min_delivery_date": "2024-08-01T14:48:45Z",
        "max_delivery_date": "2024-08-03T14:48:45Z"
      }
    ]
  };

  res.json(calculatedRate);
});


app.listen(PORT, () => {
  console.log(`App running on port ${PORT}`);
});

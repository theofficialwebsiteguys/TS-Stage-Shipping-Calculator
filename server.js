const express = require('express');
const axios = require('axios');
const cookie = require('cookie');
const crypto = require('crypto');
const querystring = require('querystring');
const request = require('request-promise');
const nonce = require('nonce');
const { Shopify } = require('@shopify/shopify-api');
//const shippo = require('shippo')(process.env.SHIPPO_API_KEY);
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Shopify.Context.initialize({
//   API_KEY: process.env.SHOPIFY_API_KEY,
//   API_SECRET_KEY: process.env.SHOPIFY_API_SECRET,
//   SCOPES: ['read_products', 'write_shipping'],
//   HOST_NAME: process.env.HOST,
//   IS_EMBEDDED_APP: false,
//   API_VERSION: '2021-04',
// });

app.get('/shopify', (req, res) => {
  const shop = req.query.shop;
  if(shop){
    const state = nonce();
    const redirectUri =  'https://ts-shipping-calculator-ab26e219466a.herokuapp.com/shopify/callback';
    const installUrl = 'https://' + shop + '/admin/oauth/authorize?client_id=' + process.env.SHOPIFY_API_KEY +
    '&scope=write_products' +
    '&state=' + state +
    '&redirect_uri=' + redirectUri;

    res.cookie('state', state);
    res.redirect(installUrl);
  } else{
    return res.status(400).send("Missing shop parameter.")
  }
});

app.get('/shopify/callback', (req, res) => {
  const { shop, hmac, code, state } = req.query;
  const stateCookie = cookie.parse(req.headers.cookie).state;

  if(state !== stateCookie) {
    return res.status(403).send('Request origin cannot be verified');
  }

  if(shop && hmac && code){
    const map = Object.assign({}, req.query);
    delete map['hmac'];
    const message = querystring.stringify(map);
    const generatedHash = crypto.createHmac('sha256', process.env.SHOPIFY_API_SECRET).update(message).digest('hex');

    if(generatedHash !== hmac) {
      return res.status(400).send('HMAC validation failed');
    }

    res.status(200).send('HMAC validated');
  }else{
    res.status(400).send('Required parameters missing');
  }
});

// OAuth route to start the authentication process
// app.get('/auth', async (req, res) => {
//   const { shop } = req.query;
//   if (!shop) {
//     return res.status(400).send('Missing shop parameter');
//   }
//   const authRoute = await Shopify.Auth.beginAuth(req, res, shop, '/auth/callback', false);
//   res.redirect(authRoute);
// });

// // OAuth callback route to handle the response from Shopify
// app.get('/auth/callback', async (req, res) => {
//   try {
//     const session = await Shopify.Auth.validateAuthCallback(req, res, req.query);
//     req.session = session;
//     await createCarrierService(session.shop, session.accessToken);
//     res.redirect('/');
//   } catch (error) {
//     console.error(error);
//     res.status(500).send(error.message);
//   }
// });

// const createCarrierService = async (shop, accessToken) => {
//   const response = await axios.post(
//     `https://${shop}/admin/api/2021-04/carrier_services.json`,
//     {
//       carrier_service: {
//         name: "Custom Shipping Rates",
//         callback_url: `https://${process.env.HOST}/calculate-shipping`,
//         service_discovery: true,
//       },
//     },
//     {
//       headers: {
//         'X-Shopify-Access-Token': accessToken,
//         'Content-Type': 'application/json',
//       },
//     }
//   );
//   return response.data;
// };

// // Endpoint to calculate shipping
// app.post('/calculate-shipping', async (req, res) => {
//   const { rate } = req.body;
//   const { origin, destination, items } = rate;

//   try {
//     const shop = req.session.shop;
//     const accessToken = req.session.accessToken;

//     let shippingCost = 0;
//     let freeShipping = false;
//     let oversized = false;

//     for (const item of items) {
//       const metafieldsResponse = await axios.get(
//         `https://${shop}/admin/api/2021-04/products/${item.product_id}/metafields.json`,
//         {
//           headers: {
//             'X-Shopify-Access-Token': accessToken,
//           },
//         }
//       );

//       const metafields = metafieldsResponse.data.metafields;
//       const length = metafields.find(mf => mf.key === 'length' && mf.namespace === 'custom').value;
//       const width = metafields.find(mf => mf.key === 'width' && mf.namespace === 'custom').value;
//       const height = metafields.find(mf => mf.key === 'height' && mf.namespace === 'custom').value;
//       const weight = metafields.find(mf => mf.key === 'weight' && mf.namespace === 'custom').value;
//       const freeShippingMetafield = metafields.find(mf => mf.key === 'free_shipping' && mf.namespace === 'global');
//       const oversizedMetafield = metafields.find(mf => mf.key === 'oversized' && mf.namespace === 'global');
//       const freeShipDiscountMetafield = metafields.find(mf => mf.key === 'free_ship_discount' && mf.namespace === 'global');

//       if (freeShippingMetafield && freeShippingMetafield.value === 'true') {
//         freeShipping = true;
//       }

//       if (oversizedMetafield && oversizedMetafield.value === 'true') {
//         oversized = true;
//       }

//       const shippingRate = await getShippingRate(
//         origin,
//         destination,
//         length,
//         width,
//         height,
//         weight,
//         item.quantity
//       );

//       shippingCost += shippingRate;
//     }

//     // Apply free shipping rules
//     if (freeShipping || shippingCost >= 299) {
//       shippingCost = 0;
//     }

//     const response = {
//       rates: [
//         {
//           service_name: "Standard Shipping",
//           service_code: "standard_shipping",
//           total_price: shippingCost * 100, // Price in cents
//           currency: "USD",
//           description: "Delivery in 5-7 business days",
//         },
//       ],
//     };

//     res.json(response);
//   } catch (error) {
//     console.error(error);
//     res.status(500).send(error.message);
//   }
// });

// const getShippingRate = async (origin, destination, length, width, height, weight, quantity) => {
//   try {
//     const parcel = await shippo.parcel.create({
//       length,
//       width,
//       height,
//       distance_unit: 'cm',
//       weight,
//       mass_unit: 'kg',
//     });

//     const shipment = await shippo.shipment.create({
//       address_from: origin,
//       address_to: destination,
//       parcels: [parcel],
//       async: false,
//     });

//     const rate = shipment.rates.find(rate => rate.servicelevel.name === 'Standard');

//     return rate ? parseFloat(rate.amount) * quantity : 0;
//   } catch (error) {
//     console.error('Error getting shipping rate from Shippo:', error);
//     return 0;
//   }
// };

app.listen(PORT, () => {
  console.log(`App running on port ${PORT}`);
});

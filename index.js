require('dotenv').config();
const express = require('express');
const OpenAI = require("openai");
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const app = express();
app.use(express.json({ limit: '10mb' }));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const verifyLicense = async (req, res, next) => {
  const key = req.headers['x-license-key'];
  if (!key) return res.status(401).json({ error: 'Missing license key' });

  const { data, error } = await supabase.from('license').select('*').eq('licenseKey', key).eq('status', 'active');
  if (error || !data.length) return res.status(403).json({ error: 'Invalid or inactive license' });

  next();
};

app.post('/enhance', verifyLicense, async (req, res) => {
  const { image } = req.body;
  if (!image) return res.status(400).json({ error: 'Image is required' });

  try {
    const prediction = await axios.post('https://api.replicate.com/v1/predictions', {
      version: "fb8af171cfa1616ddcf1242c093f9c46bcada5ad4cf6f2fbe8b81b330ec5c003",
      input: { image }
    }, {
      headers: {
        Authorization: `Token ${process.env.REPLICATE_API_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    const predictionId = prediction.data.id;

    // Poll until the image is ready
    let output = null;
    for (let i = 0; i < 20; i++) {
      const result = await axios.get(`https://api.replicate.com/v1/predictions/${predictionId}`, {
        headers: {
          Authorization: `Token ${process.env.REPLICATE_API_TOKEN}`
        }
      });

      if (result.data.status === 'succeeded') {
        output = result.data.output;
        break;
      } else if (result.data.status === 'failed') {
        throw new Error('Image processing failed');
      }

      // Wait 1 second before checking again
      await new Promise(resolve => setTimeout(resolve, 1500));
    }

    if (!output) return res.status(500).json({ error: 'Timeout waiting for image result' });

    res.json({ enhanced_image: output });
  } catch (err) {
    console.error('[REPLICATE ERROR]', err.response?.data || err.message || err);
    res.status(500).json({ error: 'Failed to process image' });
  }
});

app.post('/tags', verifyLicense, async (req, res) => {
  const { product_name } = req.body;
  try {
    const prompt = `Generate 8 SEO product tags and a 1-paragraph product description for: ${product_name || 'a product'}`;

    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: prompt }]
    });

    const message = response.choices[0].message.content;
    res.json({ result: message });
  } catch (err) {
    console.error('[OPENAI ERROR]', err.response?.data || err.message || err);
    res.status(500).json({ error: 'Failed to generate tags' });
  }
});

app.post('/activate', async (req, res) => {
  const { email, licenseKey, stripeCustomerId } = req.body;
  const { data, error } = await supabase.from('license').insert([{ email, licenseKey, stripeCustomerId, status: 'active' }]);
  if (error) return res.status(500).json({ error: 'Activation failed' });
  res.json({ success: true });
});

app.post('/verify', async (req, res) => {
  const { licenseKey } = req.body;
  const { data, error } = await supabase.from('license').select('*').eq('licenseKey', licenseKey).eq('status', 'active');
  if (error || !data.length) return res.status(403).json({ error: 'Invalid license' });
  res.json({ valid: true });
});

app.listen(3000, () => console.log('SnapBright API running on port 3000'));

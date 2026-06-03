const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const cloudinary = require("cloudinary").v2;
const { GoogleGenerativeAI } = require("@google/generative-ai");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

// --- CLOUDINARY CONFIG ---
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});
// 1. Storage for Images (Products, Clients, Technologies)
const imageStorage = new CloudinaryStorage({
  cloudinary,
  params: { folder: 'microvision' }
});
const uploadImage = multer({ storage: imageStorage });

// 2. Storage for PDFs / Resumes (🔴 'raw' prevents corruption)
const resumeStorage = new CloudinaryStorage({
  cloudinary,
  params: { 
    folder: 'microvision_resumes',
    resource_type: 'raw' // Tells Cloudinary: "Do NOT process this, it is a document!"
  }
});
const uploadResume = multer({ storage: resumeStorage });

// --- AI CONFIG ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB Connected"))
  .catch((err) => console.log(err));

// --- MODELS ---
const Product = mongoose.model(
  "Product",
  new mongoose.Schema({
    name: String,
    category: String,
    price: Number,
    description: String,
    image: String,
    unitType: { type: String, enum: ["sqft", "qty"], default: "qty" },
  })
);
const Career = mongoose.model(
  "Career",
  new mongoose.Schema({
    title: String,
    tag: String,
    desc: String,
    requirements: [String],
  })
);
const Gallery = mongoose.model(
  "Gallery",
  new mongoose.Schema({
    title: String,
    img: String,
  })
);
const Inquiry = mongoose.model(
  "Inquiry",
  new mongoose.Schema({
    productName: String,
    name: String,
    phone: String,
    email: String,
    amount: Number,
    unitType: String,
    createdAt: { type: Date, default: Date.now },
  })
);

// --- NEW MODELS ---
const Stat = mongoose.model('Stat', new mongoose.Schema({
  label: String, value: Number, suffix: String // e.g., label: "Completed Projects", value: 150, suffix: "+"
}));
const Client = mongoose.model('Client', new mongoose.Schema({
  name: String, image: String
}));
const Technology = mongoose.model('Technology', new mongoose.Schema({
  name: String, image: String
}));

// 2. ADD APPLICATION MODEL
const Application = mongoose.model('Application', new mongoose.Schema({
  jobTitle: String,
  name: String,
  phone: String,
  email: String,
  resumeUrl: String,
  createdAt: { type: Date, default: Date.now }
}));

// --- MIDDLEWARE ---
const verifyToken = (req, res, next) => {
  const token = req.headers["authorization"];
  if (!token) return res.status(403).json({ error: "Access Denied." });
  try {
    req.user = jwt.verify(token.split(" ")[1], process.env.JWT_SECRET);
    next();
  } catch (err) {
    res.status(401).json({ error: "Invalid Token" });
  }
};

// --- ROUTES ---
// Admin Login
app.post("/api/admin/login", (req, res) => {
  if (
    req.body.username === process.env.ADMIN_USER &&
    req.body.password === process.env.ADMIN_PASS
  ) {
    res.json({
      token: jwt.sign({ role: "admin" }, process.env.JWT_SECRET, {
        expiresIn: "12h",
      }),
    });
  } else res.status(401).json({ error: "Invalid credentials" });
});

// AI Suggestion Route
app.post("/api/ai/suggest", verifyToken, async (req, res) => {
  try {
    const { promptText, type } = req.body;

    // 1. Auto-discover the working models for your specific API Key
    const fetchResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`
    );
    const data = await fetchResponse.json();

    if (!data.models) {
      throw new Error("Invalid API Key or no models available.");
    }

    // 2. Find the first model that supports text generation
    // (We prefer 'flash' as it's the fastest/cheapest on the free tier)
    const validModel =
      data.models.find(
        (m) =>
          m.supportedGenerationMethods?.includes("generateContent") &&
          m.name.includes("flash")
      ) ||
      data.models.find((m) =>
        m.supportedGenerationMethods?.includes("generateContent")
      );

    if (!validModel) {
      throw new Error(
        "No supported text models found for your Google API Key."
      );
    }

    // Google returns names like "models/gemini-2.0-flash", we strip the "models/" part for the SDK
    const modelName = validModel.name.replace("models/", "");
    console.log("✅ Auto-selected working AI Model:", modelName);

    // 3. Proceed with the guaranteed working model
    const model = genAI.getGenerativeModel({ model: modelName });

    const prompt =
      type === "product"
        ? `Write a catchy, SEO-friendly title and a 2-sentence description for a product related to: ${promptText}. Format: Title: [title] | Desc: [description]`
        : `Write a professional job title and a short 2-sentence description for: ${promptText}. Format: Title: [title] | Desc: [description]`;

    const result = await model.generateContent(prompt);
    const response = result.response.text();

    res.json({ result: response });
  } catch (err) {
    console.error("🚨 AI Error:", err.message);
    res.status(500).json({
      error: "AI Generation failed: " + err.message,
    });
  }
});

// PUBLIC GET ROUTES
app.get("/api/products", async (req, res) => {
  let { search, minPrice, maxPrice, sort } = req.query;
  let query = search ? { name: { $regex: search, $options: "i" } } : {};
  if (minPrice || maxPrice)
    query.price = {
      ...(minPrice && { $gte: Number(minPrice) }),
      ...(maxPrice && { $lte: Number(maxPrice) }),
    };
  res.json(
    await Product.find(query).sort(
      sort === "price-asc"
        ? { price: 1 }
        : sort === "price-desc"
        ? { price: -1 }
        : {}
    )
  );
});
app.get("/api/products/:id", async (req, res) =>
  res.json(await Product.findById(req.params.id))
);
app.get("/api/careers", async (req, res) => res.json(await Career.find()));
app.get("/api/gallery", async (req, res) => res.json(await Gallery.find()));
app.get("/api/stats", async (req, res) => res.json(await Stat.find()));
app.get("/api/clients", async (req, res) => res.json(await Client.find()));
app.get("/api/technologies", async (req, res) =>
  res.json(await Technology.find())
);

// PUBLIC POST (Inquiries)
app.post("/api/inquiries", async (req, res) => {
  await Inquiry.create(req.body);
  res.json({ success: true });
});

app.post(
  "/api/applications",
  uploadResume.single("resume"),
  async (req, res) => {
    try {
      const newApp = await Application.create({
        jobTitle: req.body.jobTitle,
        name: req.body.name,
        phone: req.body.phone,
        email: req.body.email,
        resumeUrl: req.file ? req.file.path : null,
      });
      res.json({ success: true, application: newApp });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);


// --- PROTECTED ADMIN CRUD ROUTES ---
app.get("/api/applications", verifyToken, async (req, res) => {
  res.json(await Application.find().sort({ createdAt: -1 }));
});
app.delete("/api/applications/:id", verifyToken, async (req, res) => {
  res.json(await Application.findByIdAndDelete(req.params.id));
});

// PRODUCTS CRUD
app.post(
  "/api/products",
  verifyToken,
  uploadImage.single("image"),
  async (req, res) => {
    res.json(
      await Product.create({
        ...req.body,
        image: req.file ? req.file.path : req.body.image,
      })
    );
  }
);
app.put(
  "/api/products/:id",
  verifyToken,
  uploadImage.single("image"),
  async (req, res) => {
    const updateData = { ...req.body };
    if (req.file) updateData.image = req.file.path;
    res.json(
      await Product.findByIdAndUpdate(req.params.id, updateData, { new: true })
    );
  }
);
app.delete("/api/products/:id", verifyToken, async (req, res) =>
  res.json(await Product.findByIdAndDelete(req.params.id))
);

// CAREERS CRUD
app.post("/api/careers", verifyToken, async (req, res) => {
  req.body.requirements = req.body.requirements.split(",").map((r) => r.trim());
  res.json(await Career.create(req.body));
});
app.put("/api/careers/:id", verifyToken, async (req, res) => {
  if (typeof req.body.requirements === "string")
    req.body.requirements = req.body.requirements
      .split(",")
      .map((r) => r.trim());
  res.json(
    await Career.findByIdAndUpdate(req.params.id, req.body, { new: true })
  );
});
app.delete("/api/careers/:id", verifyToken, async (req, res) =>
  res.json(await Career.findByIdAndDelete(req.params.id))
);

// GALLERY CRUD
app.post(
  "/api/gallery",
  verifyToken,
  uploadImage.single("image"),
  async (req, res) => {
    res.json(
      await Gallery.create({
        title: req.body.title,
        img: req.file ? req.file.path : req.body.img,
      })
    );
  }
);
app.put(
  "/api/gallery/:id",
  verifyToken,
  uploadImage.single("image"),
  async (req, res) => {
    const updateData = { title: req.body.title };
    if (req.file) updateData.img = req.file.path;
    res.json(
      await Gallery.findByIdAndUpdate(req.params.id, updateData, { new: true })
    );
  }
);
app.delete("/api/gallery/:id", verifyToken, async (req, res) =>
  res.json(await Gallery.findByIdAndDelete(req.params.id))
);

// INQUIRIES ADMIN
app.get("/api/inquiries", verifyToken, async (req, res) =>
  res.json(await Inquiry.find().sort({ createdAt: -1 }))
);

// STATS CRUD
app.post('/api/stats', verifyToken, async (req, res) => res.json(await Stat.create(req.body)));
app.put('/api/stats/:id', verifyToken, async (req, res) => res.json(await Stat.findByIdAndUpdate(req.params.id, req.body, { new: true })));
app.delete('/api/stats/:id', verifyToken, async (req, res) => res.json(await Stat.findByIdAndDelete(req.params.id)));

// CLIENTS CRUD
app.post(
  "/api/clients",
  verifyToken,
  uploadImage.single("image"),
  async (req, res) =>
    res.json(
      await Client.create({
        name: req.body.name,
        image: req.file ? req.file.path : req.body.image,
      })
    )
);
app.put(
  "/api/clients/:id",
  verifyToken,
  uploadImage.single("image"),
  async (req, res) => {
    const updateData = { name: req.body.name };
    if (req.file) updateData.image = req.file.path;
    res.json(
      await Client.findByIdAndUpdate(req.params.id, updateData, { new: true })
    );
  }
);
app.delete('/api/clients/:id', verifyToken, async (req, res) => res.json(await Client.findByIdAndDelete(req.params.id)));

// TECHNOLOGIES CRUD
app.post(
  "/api/technologies",
  verifyToken,
  uploadImage.single("image"),
  async (req, res) =>
    res.json(
      await Technology.create({
        name: req.body.name,
        image: req.file ? req.file.path : req.body.image,
      })
    )
);
app.put(
  "/api/technologies/:id",
  verifyToken,
  uploadImage.single("image"),
  async (req, res) => {
    const updateData = { name: req.body.name };
    if (req.file) updateData.image = req.file.path;
    res.json(
      await Technology.findByIdAndUpdate(req.params.id, updateData, {
        new: true,
      })
    );
  }
);
app.delete('/api/technologies/:id', verifyToken, async (req, res) => res.json(await Technology.findByIdAndDelete(req.params.id)));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server on port ${PORT}`));

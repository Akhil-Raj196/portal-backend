require("dotenv").config({ quiet: true });

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const { cleanupLegacyDemoData, initializePortalState } = require("./utils/hrState");

const app = express();
const port = process.env.PORT || 5000;
const mongoUri =
  process.env.MONGODB_URI ||
  process.env.MONGO_URI ||
  process.env.DATABASE_URL ||
  process.env.MONGODB_URL;
const allowedOrigins = [
  process.env.FRONTEND_URL,
  process.env.CORS_ORIGIN,
  "https://p-dashboard.onrender.com",
  "http://localhost:3000"
].filter(Boolean);

const corsOptions = {
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  optionsSuccessStatus: 204
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json());

mongoose.set("bufferCommands", false);

app.get("/api/health", (_req, res) => {
  res.json({
    success: true,
    dbState: mongoose.connection.readyState
  });
});

// routes
app.use("/api/users", require("./routes/userRoutes"));
app.use("/api/hr", require("./routes/hrRoutes"));

const startServer = async () => {
  if (!mongoUri) {
    throw new Error(
      "Missing MongoDB connection string. Set MONGODB_URI, MONGO_URI, DATABASE_URL, or MONGODB_URL in the service environment."
    );
  }

  console.log("Connecting to MongoDB...");
  await mongoose.connect(mongoUri, {
    serverSelectionTimeoutMS: 10000
  });
  console.log("MongoDB connection established.");

  console.log("Initializing portal state...");
  await initializePortalState();
  console.log("Portal state initialized.");

  console.log("Cleaning legacy demo data...");
  await cleanupLegacyDemoData();
  console.log("Legacy demo data cleanup complete.");

  app.listen(port, () => console.log(`Server running on ${port}`));
  console.log("DB Connected");
};

startServer().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const { cleanupLegacyDemoData, initializePortalState } = require("./utils/hrState");

const app = express();
const port = process.env.PORT || 5000;
const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;

app.use(express.json());
app.use(cors());

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
    throw new Error("Missing MONGODB_URI (or MONGO_URI) environment variable");
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

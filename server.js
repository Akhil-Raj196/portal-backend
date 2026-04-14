const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const { cleanupLegacyDemoData, initializePortalState } = require("./utils/hrState");

const app = express();
app.use(express.json());
app.use(cors());

// connect DB
mongoose.connect("mongodb://Akhilesh:Rajak%40123@localhost:27017/studentDB?authSource=admin")
.then(async () => {
  await initializePortalState();
  await cleanupLegacyDemoData();
  console.log("DB Connected");
})
.catch(err => console.log(err));

// routes
app.use("/api/users", require("./routes/userRoutes"));
app.use("/api/hr", require("./routes/hrRoutes"));

app.listen(5000, () => console.log("Server running on 5000"));

const express = require("express");
const router = express.Router();
const User = require("../models/User");


// 🔹 CREATE
router.post("/", async (req, res) => {
  const user = new User(req.body);
  await user.save();
  res.send(user);
});


// 🔹 GET ALL
router.get("/", async (req, res) => {
  const users = await User.find();
  res.send(users);
});


// 🔹 UPDATE
router.put("/:id", async (req, res) => {
  const user = await User.findByIdAndUpdate(req.params.id, req.body, { returnDocument: "after" });
  res.send(user);
});


// 🔹 DELETE USER
router.delete("/:id", async (req, res) => {
  await User.findByIdAndDelete(req.params.id);
  res.send("User deleted");
});


// 🔹 DELETE EDUCATION ENTRY
router.delete("/education/:userId/:eduId", async (req, res) => {
  const user = await User.findById(req.params.userId);

  user.educationDetails = user.educationDetails.filter(
    edu => edu.id !== req.params.eduId
  );

  await user.save();
  res.send(user);
});


// 🔹 DELETE DOCUMENT
router.delete("/doc/:userId/:type", async (req, res) => {
  const user = await User.findById(req.params.userId);

  if (req.params.type === "aadhar") {
    user.verificationDocs.aadharImage = "";
  } else {
    user.verificationDocs.panImage = "";
  }

  await user.save();
  res.send(user);
});

module.exports = router;

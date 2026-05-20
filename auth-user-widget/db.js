const mongoose = require("mongoose");

mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/authdb")
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.log("⚠️  MongoDB error:", err.message));

const User = mongoose.model("User", new mongoose.Schema({
  googleId:  { type: String, unique: true, sparse: true },
  name:      String,
  email:     String,
  avatar:    String,
  createdAt: { type: Date, default: Date.now },
}));

module.exports = { User };

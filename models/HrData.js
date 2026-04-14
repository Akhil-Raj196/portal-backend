const mongoose = require("mongoose");

const { Mixed } = mongoose.Schema.Types;

const hrDataSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: "default" },
    attendance: { type: [Mixed], default: [] },
    attendanceSessions: { type: [Mixed], default: [] },
    holidays: { type: [Mixed], default: [] },
    regularizationRequests: { type: [Mixed], default: [] },
    leaves: { type: [Mixed], default: [] },
    organizationPosts: { type: [Mixed], default: [] },
    salarySlips: { type: [Mixed], default: [] },
    notifications: { type: [Mixed], default: [] },
    chats: { type: [Mixed], default: [] },
    activityLogs: { type: [Mixed], default: [] },
    inviteLinks: { type: [Mixed], default: [] }
  },
  { timestamps: true }
);

module.exports = mongoose.model("HrData", hrDataSchema);

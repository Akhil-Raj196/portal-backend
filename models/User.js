const mongoose = require("mongoose");

const educationSchema = new mongoose.Schema(
  {
    id: String,
    degree: String,
    institution: String,
    year: String,
    score: String
  },
  { _id: false }
);

const verificationSchema = new mongoose.Schema(
  {
    aadharNumber: String,
    panNumber: String,
    nameOnAadhar: String,
    nameOnPan: String,
    aadharImage: String,
    panImage: String
  },
  { _id: false }
);

const personalDetailsSchema = new mongoose.Schema(
  {
    dob: String,
    gender: String,
    maritalStatus: String,
    bloodGroup: String,
    nationality: String,
    address: String,
    city: String,
    state: String,
    postalCode: String,
    emergencyContactName: String,
    emergencyContactPhone: String,
    joiningDate: String,
    employeeCode: String
  },
  { _id: false }
);

const payrollDetailsSchema = new mongoose.Schema(
  {
    firstName: String,
    lastName: String,
    employeeCode: String,
    pfNumber: String,
    esiNumber: String,
    accountNumber: String,
    ifscCode: String,
    bankName: String,
    ctcAnnual: { type: Number, default: 0 },
    currency: { type: String, default: "USD" },
    basicPct: { type: Number, default: 40 },
    hraPct: { type: Number, default: 20 },
    conveyanceFixed: { type: Number, default: 0 },
    medicalFixed: { type: Number, default: 0 },
    specialAllowanceFixed: { type: Number, default: 0 },
    otherAllowanceFixed: { type: Number, default: 0 },
    pfRate: { type: Number, default: 12 },
    esiRate: { type: Number, default: 0.75 },
    professionalTax: { type: Number, default: 200 },
    tds: { type: Number, default: 0 },
    loanDeduction: { type: Number, default: 0 }
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    passwordChangeRequired: { type: Boolean, default: false },
    tempPasswordIssuedAt: String,
    role: { type: String, default: "employee" },
    permissions: { type: [String], default: [] },
    designation: String,
    department: String,
    phone: String,
    location: String,
    image: String,
    managerId: { type: String, default: null },
    dob: String,
    personalDetails: personalDetailsSchema,
    educationDetails: { type: [educationSchema], default: [] },
    verificationDocs: verificationSchema,
    payrollDetails: payrollDetailsSchema
  },
  { timestamps: true }
);

module.exports = mongoose.model("User", userSchema);

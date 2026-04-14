const express = require("express");

const User = require("../models/User");
const { ROLE_PERMISSIONS } = require("../config/hrPortalConfig");
const { buildBootstrapPayload, getHrDataDoc } = require("../utils/hrState");
const { computeSalarySlipForPeriod, getCurrentMonthPeriod } = require("../utils/salarySlip");
const { isMailerConfigured, sendInviteCredentialsEmail } = require("../utils/email");

const router = express.Router();

const toDateString = (date) => date.toISOString().slice(0, 10);

const inferLocationFromTimezone = (timezone) => {
  if (!timezone) return "Unknown location";
  const parts = timezone.split("/");
  if (parts.length < 2) return timezone;
  return `${parts[1].replace(/_/g, " ")}, ${parts[0]}`;
};

const createLogEntry = (action, user, timezone, location) => ({
  id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  action,
  userId: user.id,
  userName: user.name,
  timezone,
  location,
  timestamp: new Date().toISOString()
});

const calculateLeaveDays = (fromDate, toDate, dayType = "Full Day") => {
  if (!fromDate || !toDate) return 0;
  const start = new Date(fromDate);
  const end = new Date(toDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return 0;

  const millis = end.setHours(0, 0, 0, 0) - start.setHours(0, 0, 0, 0);
  const dayCount = Math.floor(millis / (1000 * 60 * 60 * 24)) + 1;
  return dayType === "Half Day" ? 0.5 : dayCount;
};

const getApprovalRoleLabel = (user) => {
  if (!user) return "Approver";
  if (user.role === "admin") return "HR";
  if (/manager/i.test(user.designation || "")) return "Manager";
  if (/senior/i.test(user.designation || "")) return "Senior";
  return "Approver";
};

const createInviteToken = () => `inv-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const ALLOWED_IMAGE_MIME_TYPES = ["image/jpeg", "image/png"];
const ALLOWED_DOCUMENT_MIME_TYPES = [...ALLOWED_IMAGE_MIME_TYPES, "application/pdf"];

const ensurePostShape = (post) => ({
  ...post,
  attachments: Array.isArray(post.attachments) ? post.attachments : [],
  likes: Array.isArray(post.likes) ? post.likes : [],
  comments: Array.isArray(post.comments) ? post.comments : []
});

const getDataUrlMimeType = (value = "") => {
  const match = typeof value === "string" ? value.match(/^data:([^;]+);base64,/i) : null;
  return match ? match[1].toLowerCase() : "";
};

const validateDataUrlMimeType = (value, allowedMimeTypes, fieldLabel) => {
  if (!value) return null;
  const mimeType = getDataUrlMimeType(value);
  if (!mimeType || !allowedMimeTypes.includes(mimeType)) {
    throw new Error(`${fieldLabel} must be one of: ${allowedMimeTypes.join(", ")}`);
  }
  return mimeType;
};

const sanitizePostAttachments = (attachments = []) =>
  attachments.map((attachment) => {
    const mimeType = validateDataUrlMimeType(
      attachment?.url,
      ALLOWED_DOCUMENT_MIME_TYPES,
      attachment?.name || "Attachment"
    );

    return {
      id: attachment?.id || `att-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      type: mimeType === "application/pdf" ? "pdf" : "image",
      mimeType,
      name: attachment?.name || "attachment",
      url: attachment.url
    };
  });

const sendBootstrap = async (res, currentUserId = null) => res.json(await buildBootstrapPayload(currentUserId));

const getUserByPortalId = async (userId) => User.findOne({ id: userId });

const getEligibleApprovers = (employee, users) => {
  const manager = employee.managerId ? users.find((u) => u.id === employee.managerId) : null;
  const hrAndSenior = users.filter(
    (u) =>
      u.id !== employee.id &&
      (u.role === "admin" || (/senior/i.test(u.designation || "") && u.department === employee.department))
  );

  return [manager, ...hrAndSenior].filter(Boolean);
};

const buildApproverQueue = (employee, users, selectedApproverIds = []) => {
  const eligibleApprovers = getEligibleApprovers(employee, users);
  const approverMap = eligibleApprovers.reduce((acc, approver) => {
    acc[approver.id] = approver;
    return acc;
  }, {});

  const selectedApprovers = selectedApproverIds.map((id) => approverMap[id]).filter(Boolean);
  const fallbackApprovers = eligibleApprovers.filter((approver) => !selectedApproverIds.includes(approver.id));
  const allApprovers = [...selectedApprovers, ...fallbackApprovers];
  const unique = [];
  const seen = new Set();

  allApprovers.forEach((approver) => {
    if (seen.has(approver.id)) return;
    seen.add(approver.id);
    unique.push(approver);
  });

  return unique.map((approver, idx) => ({
    approverId: approver.id,
    approverRole: getApprovalRoleLabel(approver),
    status: idx === 0 ? "Pending" : "Awaiting",
    comment: "",
    actedAt: null
  }));
};

router.get("/bootstrap", async (req, res, next) => {
  try {
    const currentUserId = req.query.currentUserId || null;
    await sendBootstrap(res, currentUserId);
  } catch (error) {
    next(error);
  }
});

router.post("/login", async (req, res, next) => {
  try {
    const { email, password, timezone } = req.body;
    const user = await User.findOne({ email });

    if (!user || user.password !== password) {
      return res.status(401).json({ success: false, message: "Invalid email or password" });
    }

    const hrData = await getHrDataDoc();
    hrData.activityLogs.unshift(
      createLogEntry("LOGIN", user, timezone || "UTC", inferLocationFromTimezone(timezone))
    );
    await hrData.save();

    res.json({
      success: true,
      message: "Login successful",
      state: await buildBootstrapPayload(user.id),
      user: user.toObject(),
      requiresPasswordChange: Boolean(user.passwordChangeRequired)
    });
  } catch (error) {
    next(error);
  }
});

router.post("/invite-login", async (req, res, next) => {
  try {
    const { token, timezone } = req.body;
    const hrData = await getHrDataDoc();
    const invite = hrData.inviteLinks.find((item) => item.token === token);

    if (!invite) {
      return res.status(404).json({ success: false, message: "Invalid invite link." });
    }
    if (invite.used) {
      return res.status(400).json({ success: false, message: "Invite link already used." });
    }
    if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) {
      return res.status(400).json({ success: false, message: "Invite link expired." });
    }

    const user = await getUserByPortalId(invite.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found for this invite." });
    }

    invite.used = true;
    invite.usedAt = new Date().toISOString();
    hrData.activityLogs.unshift(
      createLogEntry("LOGIN", user, timezone || "UTC", inferLocationFromTimezone(timezone))
    );
    await hrData.save();

    res.json({
      success: true,
      state: await buildBootstrapPayload(user.id),
      user: user.toObject(),
      requiresPasswordChange: Boolean(user.passwordChangeRequired)
    });
  } catch (error) {
    next(error);
  }
});

router.post("/change-password", async (req, res, next) => {
  try {
    const { userId, currentPassword, newPassword } = req.body;

    if (!userId || !currentPassword || !newPassword) {
      return res.status(400).json({ success: false, message: "Current password and new password are required." });
    }

    if (newPassword.trim().length < 6) {
      return res.status(400).json({ success: false, message: "New password must be at least 6 characters long." });
    }

    const user = await getUserByPortalId(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    if (user.password !== currentPassword) {
      return res.status(400).json({ success: false, message: "Current password is incorrect." });
    }

    user.password = newPassword;
    user.passwordChangeRequired = false;
    user.tempPasswordIssuedAt = "";
    await user.save();

    const hrData = await getHrDataDoc();
    hrData.notifications.unshift({
      id: `n-${Date.now()}-pwd-updated`,
      userId: user.id,
      title: "Password updated",
      message: "Your portal password was updated successfully.",
      channel: "app",
      status: "sent",
      createdAt: new Date().toISOString(),
      read: false
    });
    await hrData.save();

    res.json({
      success: true,
      state: await buildBootstrapPayload(user.id),
      user: user.toObject()
    });
  } catch (error) {
    next(error);
  }
});

router.post("/logout", async (req, res, next) => {
  try {
    const { userId, timezone } = req.body;
    const user = await getUserByPortalId(userId);
    if (user) {
      const hrData = await getHrDataDoc();
      hrData.activityLogs.unshift(
        createLogEntry("LOGOUT", user, timezone || "UTC", inferLocationFromTimezone(timezone))
      );
      await hrData.save();
    }
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

router.post("/attendance/clock-in", async (req, res, next) => {
  try {
    const { userId } = req.body;
    const hrData = await getHrDataDoc();
    const today = toDateString(new Date());
    const openSession = hrData.attendanceSessions.find(
      (session) => session.userId === userId && session.date === today && !session.clockOut
    );

    if (openSession) {
      return res.status(400).json({ success: false, message: "Attendance already started for today." });
    }

    const nowIso = new Date().toISOString();
    hrData.attendanceSessions.push({
      id: `as-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      userId,
      date: today,
      clockIn: nowIso,
      clockOut: null,
      workedMinutes: 0
    });

    const attendanceIndex = hrData.attendance.findIndex(
      (record) => record.userId === userId && record.date === today
    );

    if (attendanceIndex >= 0) {
      hrData.attendance[attendanceIndex].status = "Present";
    } else {
      hrData.attendance.push({
        id: `a-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        userId,
        date: today,
        status: "Present"
      });
    }

    await hrData.save();
    res.json({ success: true, state: await buildBootstrapPayload(userId) });
  } catch (error) {
    next(error);
  }
});

router.post("/attendance/clock-out", async (req, res, next) => {
  try {
    const { userId } = req.body;
    const hrData = await getHrDataDoc();
    const now = new Date();
    const openIndexes = hrData.attendanceSessions
      .map((session, index) => ({ session, index }))
      .filter(({ session }) => session.userId === userId && !session.clockOut);

    if (openIndexes.length === 0) {
      return res.status(400).json({ success: false, message: "No active attendance session to end." });
    }

    const { index } = openIndexes[openIndexes.length - 1];
    const active = hrData.attendanceSessions[index];
    const inTime = new Date(active.clockIn);

    hrData.attendanceSessions[index] = {
      ...active,
      clockOut: now.toISOString(),
      workedMinutes: Math.max(Math.round((now - inTime) / 60000), 0)
    };

    await hrData.save();
    res.json({ success: true, state: await buildBootstrapPayload(userId) });
  } catch (error) {
    next(error);
  }
});

router.put("/access/:userId", async (req, res, next) => {
  try {
    const { role, permissions } = req.body;
    const updated = await User.findOneAndUpdate(
      { id: req.params.userId },
      {
        role,
        permissions: role === "admin" ? ROLE_PERMISSIONS.admin : permissions
      },
      { returnDocument: "after" }
    );

    if (!updated) {
      return res.status(404).json({ success: false, message: "Employee not found." });
    }

    res.json({ success: true, state: await buildBootstrapPayload(req.body.currentUserId || null) });
  } catch (error) {
    next(error);
  }
});

router.post("/invites", async (req, res, next) => {
  try {
    const {
      currentUserId,
      name,
      email,
      department,
      designation,
      managerId,
      permissions = ROLE_PERMISSIONS.employee,
      appBaseUrl
    } = req.body;
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(400).json({ success: false, message: "Email already exists." });
    }

    const creator = await getUserByPortalId(currentUserId);
    if (managerId) {
      const manager = await getUserByPortalId(managerId);
      if (!manager) {
        return res.status(400).json({ success: false, message: "Selected reporting manager not found." });
      }
    }
    const userId = `u-${Date.now()}`;
    const password = `temp-${Math.random().toString(36).slice(2, 8)}`;
    const employeeCode = `${(department || "EMP").slice(0, 3).toUpperCase()}-${userId.slice(-4).toUpperCase()}`;

    await User.create({
      id: userId,
      name,
      email: email.toLowerCase(),
      password,
      passwordChangeRequired: true,
      tempPasswordIssuedAt: new Date().toISOString(),
      role: "employee",
      permissions,
      designation: designation || `${department} Associate`,
      department,
      location: "",
      phone: "",
      image: "",
      managerId: managerId || creator?.id || null,
      personalDetails: {
        employeeCode,
        joiningDate: new Date().toISOString().slice(0, 10)
      }
    });

    const hrData = await getHrDataDoc();
    const token = createInviteToken();
    const loginUrl = appBaseUrl || "http://localhost:3000/ingeniousportal";
    const portalLink = `${loginUrl}/invite/${token}`;

    hrData.inviteLinks.unshift({
      token,
      userId,
      email: email.toLowerCase(),
      createdBy: currentUserId,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString(),
      used: false
    });

    hrData.notifications.unshift(
      {
        id: `n-${Date.now()}-invite-admin`,
        userId: currentUserId,
        title: "Employee Portal Link Generated",
        message: `Portal link for ${email}: ${portalLink}`,
        channel: "app",
        status: "sent",
        createdAt: new Date().toISOString(),
        read: false
      },
      {
        id: `n-${Date.now()}-invite-user`,
        userId,
        title: "Ingenious Portal Access Link",
        message: `Use this portal link to sign in directly: ${portalLink}`,
        channel: "email",
        status: "sent",
        createdAt: new Date().toISOString(),
        read: false
      }
    );

    const emailResult = await sendInviteCredentialsEmail({
      to: email.toLowerCase(),
      employeeName: name,
      loginUrl,
      tempPassword: password
    });

    const adminMessage = emailResult.delivered
      ? `Portal account created and invite email sent to ${email}.`
      : `Portal account created for ${email}, but email was not sent: ${emailResult.message}`;

    hrData.notifications.unshift({
      id: `n-${Date.now()}-invite-email-status`,
      userId: currentUserId,
      title: emailResult.delivered ? "Invite email sent" : "Invite email pending",
      message: adminMessage,
      channel: "app",
      status: emailResult.delivered ? "sent" : "pending",
      createdAt: new Date().toISOString(),
      read: false
    });

    await hrData.save();
    res.json({
      success: true,
      portalLink,
      tempPassword: emailResult.delivered ? undefined : password,
      emailDelivered: emailResult.delivered,
      emailMessage: emailResult.message,
      mailerConfigured: isMailerConfigured(),
      state: await buildBootstrapPayload(currentUserId)
    });
  } catch (error) {
    next(error);
  }
});

router.put("/users/:userId/profile", async (req, res, next) => {
  try {
    const user = await getUserByPortalId(req.params.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    const nextProfile = req.body;
    const personalDetails = {
      ...(user.personalDetails || {}),
      ...(nextProfile.personalDetails || {})
    };
    const verificationDocs = {
      ...(user.verificationDocs || {}),
      ...(nextProfile.verificationDocs || {})
    };
    validateDataUrlMimeType(nextProfile.image, ALLOWED_IMAGE_MIME_TYPES, "Profile photo");
    validateDataUrlMimeType(verificationDocs.aadharImage, ALLOWED_DOCUMENT_MIME_TYPES, "Aadhar document");
    validateDataUrlMimeType(verificationDocs.panImage, ALLOWED_DOCUMENT_MIME_TYPES, "PAN document");

    user.name = nextProfile.name ?? user.name;
    user.designation = nextProfile.designation ?? user.designation;
    user.department = nextProfile.department ?? user.department;
    user.phone = nextProfile.phone ?? user.phone;
    user.location = nextProfile.location ?? user.location;
    user.image = nextProfile.image ?? user.image;
    user.dob = personalDetails.dob || user.dob;
    user.personalDetails = personalDetails;
    user.verificationDocs = verificationDocs;
    user.educationDetails = Array.isArray(nextProfile.educationDetails)
      ? nextProfile.educationDetails
      : user.educationDetails;

    await user.save();
    res.json({ success: true, state: await buildBootstrapPayload(req.body.currentUserId || user.id) });
  } catch (error) {
    next(error);
  }
});

router.delete("/users/:userId/education/:educationId", async (req, res, next) => {
  try {
    const user = await getUserByPortalId(req.params.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    user.educationDetails = (user.educationDetails || []).filter((edu) => edu.id !== req.params.educationId);
    await user.save();
    res.json({ success: true, state: await buildBootstrapPayload(req.params.userId) });
  } catch (error) {
    next(error);
  }
});

router.delete("/users/:userId/documents/:type", async (req, res, next) => {
  try {
    const user = await getUserByPortalId(req.params.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    const docs = { ...(user.verificationDocs || {}) };
    if (req.params.type === "aadhar") {
      docs.aadharImage = "";
      docs.aadharNumber = "";
    } else if (req.params.type === "pan") {
      docs.panImage = "";
      docs.panNumber = "";
    }

    user.verificationDocs = docs;
    await user.save();
    res.json({ success: true, state: await buildBootstrapPayload(req.params.userId) });
  } catch (error) {
    next(error);
  }
});

router.put("/users/:userId/payroll", async (req, res, next) => {
  try {
    const user = await getUserByPortalId(req.params.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "Employee not found." });
    }

    const payrollInput = req.body.payroll || req.body;
    const mergedPayroll = {
      ...(user.payrollDetails || {}),
      ...payrollInput,
      ctcAnnual: Number(payrollInput.ctcAnnual || 0),
      basicPct: Number(payrollInput.basicPct ?? user.payrollDetails?.basicPct ?? 40),
      hraPct: Number(payrollInput.hraPct ?? user.payrollDetails?.hraPct ?? 20),
      conveyanceFixed: Number(payrollInput.conveyanceFixed ?? user.payrollDetails?.conveyanceFixed ?? 0),
      medicalFixed: Number(payrollInput.medicalFixed ?? user.payrollDetails?.medicalFixed ?? 0),
      specialAllowanceFixed: Number(payrollInput.specialAllowanceFixed ?? user.payrollDetails?.specialAllowanceFixed ?? 0),
      otherAllowanceFixed: Number(payrollInput.otherAllowanceFixed ?? user.payrollDetails?.otherAllowanceFixed ?? 0),
      pfRate: Number(payrollInput.pfRate ?? user.payrollDetails?.pfRate ?? 12),
      esiRate: Number(payrollInput.esiRate ?? user.payrollDetails?.esiRate ?? 0.75),
      professionalTax: Number(payrollInput.professionalTax ?? user.payrollDetails?.professionalTax ?? 200),
      tds: Number(payrollInput.tds ?? user.payrollDetails?.tds ?? 0),
      loanDeduction: Number(payrollInput.loanDeduction ?? user.payrollDetails?.loanDeduction ?? 0)
    };

    const fullName = `${(mergedPayroll.firstName || "").trim()} ${(mergedPayroll.lastName || "").trim()}`.trim();
    user.payrollDetails = mergedPayroll;
    user.name = fullName || user.name;
    user.personalDetails = {
      ...(user.personalDetails || {}),
      employeeCode: mergedPayroll.employeeCode || user.personalDetails?.employeeCode || ""
    };
    await user.save();

    const hrData = await getHrDataDoc();
    const period = getCurrentMonthPeriod(new Date());
    const generatedSlip = computeSalarySlipForPeriod({
      user: user.toObject(),
      attendanceSessions: hrData.attendanceSessions,
      leaves: hrData.leaves,
      holidays: hrData.holidays,
      year: period.year,
      monthIndex: period.monthIndex,
      generatedAt: new Date().toISOString()
    });

    hrData.salarySlips = [
      generatedSlip,
      ...hrData.salarySlips.filter((slip) => !(slip.userId === user.id && slip.period?.key === period.key))
    ];
    hrData.notifications.unshift({
      id: `n-${Date.now()}-payroll-update`,
      userId: user.id,
      title: "Payroll profile updated",
      message: "HR updated your salary profile and generated this month salary slip.",
      channel: "app",
      status: "sent",
      createdAt: new Date().toISOString(),
      read: false
    });

    await hrData.save();
    res.json({ success: true, state: await buildBootstrapPayload(req.body.currentUserId || null) });
  } catch (error) {
    next(error);
  }
});

router.post("/leaves", async (req, res, next) => {
  try {
    const { currentUserId, selectedApproverIds = [], ...leaveInput } = req.body;
    const users = await User.find().lean();
    const currentUser = users.find((user) => user.id === currentUserId);

    if (!currentUser) {
      return res.status(401).json({ success: false, message: "User not logged in." });
    }

    const dayType = leaveInput.dayType || "Full Day";
    const leaveDays = calculateLeaveDays(leaveInput.fromDate, leaveInput.toDate, dayType);
    const approvalFlow = buildApproverQueue(currentUser, users, selectedApproverIds);
    const currentApproverId = approvalFlow[0]?.approverId || null;
    const firstRole = approvalFlow[0]?.approverRole;

    const leave = {
      id: `l-${Date.now()}`,
      userId: currentUserId,
      ...leaveInput,
      selectedApproverIds,
      dayType,
      leaveDays,
      status: currentApproverId ? `Pending with ${firstRole}` : "Pending",
      adminComment: "",
      approvalFlow,
      currentApprovalIndex: approvalFlow.length > 0 ? 0 : -1,
      currentApproverId
    };

    const hrData = await getHrDataDoc();
    hrData.leaves.unshift(leave);

    approvalFlow.forEach((step) => {
      hrData.notifications.unshift({
        id: `n-${Date.now()}-${step.approverId}-${Math.random().toString(36).slice(2, 5)}`,
        userId: step.approverId,
        title: "New leave request",
        message: `${currentUser.name} submitted ${leave.type} (${leaveDays} day(s)).`,
        channel: "email",
        status: "sent",
        createdAt: new Date().toISOString(),
        read: false
      });
    });

    await hrData.save();
    res.json({ success: true, state: await buildBootstrapPayload(currentUserId) });
  } catch (error) {
    next(error);
  }
});

router.post("/leaves/:leaveId/action", async (req, res, next) => {
  try {
    const { currentUserId, action, comment = "" } = req.body;
    const users = await User.find().lean();
    const currentUser = users.find((user) => user.id === currentUserId);
    const hrData = await getHrDataDoc();
    const targetLeave = hrData.leaves.find((leave) => leave.id === req.params.leaveId);

    if (!currentUser || !targetLeave) {
      return res.status(404).json({ success: false, message: "Leave request not found." });
    }

    const pendingIndex = (targetLeave.approvalFlow || []).findIndex(
      (step) => step.approverId === currentUserId && step.status === "Pending"
    );
    if (pendingIndex === -1) {
      return res.status(400).json({ success: false, message: "Leave request is not pending for you." });
    }

    targetLeave.approvalFlow[pendingIndex] = {
      ...targetLeave.approvalFlow[pendingIndex],
      status: action === "Approved" ? "Approved" : "Denied",
      comment,
      actedAt: new Date().toISOString()
    };

    if (action === "Denied") {
      targetLeave.status = "Denied";
      targetLeave.currentApprovalIndex = -1;
      targetLeave.currentApproverId = null;
      hrData.notifications.unshift({
        id: `n-${Date.now()}-leave-denied`,
        userId: targetLeave.userId,
        title: "Leave denied",
        message: `Your ${targetLeave.type} request was denied by ${currentUser.name}.`,
        channel: "email",
        status: "sent",
        createdAt: new Date().toISOString(),
        read: false
      });
    } else {
      const nextIndex = pendingIndex + 1;
      if (nextIndex < targetLeave.approvalFlow.length) {
        targetLeave.approvalFlow[nextIndex] = {
          ...targetLeave.approvalFlow[nextIndex],
          status: "Pending"
        };
        targetLeave.currentApprovalIndex = nextIndex;
        targetLeave.currentApproverId = targetLeave.approvalFlow[nextIndex].approverId;
        targetLeave.status = `Pending with ${targetLeave.approvalFlow[nextIndex].approverRole}`;
        hrData.notifications.unshift({
          id: `n-${Date.now()}-leave-next`,
          userId: targetLeave.currentApproverId,
          title: "Leave approval pending",
          message: `${users.find((user) => user.id === targetLeave.userId)?.name || "Employee"} leave request awaits your review.`,
          channel: "email",
          status: "sent",
          createdAt: new Date().toISOString(),
          read: false
        });
      } else {
        targetLeave.status = "Approved";
        targetLeave.currentApprovalIndex = -1;
        targetLeave.currentApproverId = null;
        hrData.notifications.unshift({
          id: `n-${Date.now()}-leave-approved`,
          userId: targetLeave.userId,
          title: "Leave approved",
          message: `Your ${targetLeave.type} request is fully approved.`,
          channel: "email",
          status: "sent",
          createdAt: new Date().toISOString(),
          read: false
        });
      }
    }

    targetLeave.adminComment = comment || targetLeave.adminComment;
    await hrData.save();
    res.json({ success: true, state: await buildBootstrapPayload(currentUserId) });
  } catch (error) {
    next(error);
  }
});

router.post("/chats/messages", async (req, res, next) => {
  try {
    const { currentUserId, toUserId, text } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ success: false, message: "Message cannot be empty." });
    }

    const sender = await getUserByPortalId(currentUserId);
    const receiver = await getUserByPortalId(toUserId);
    if (!sender || !receiver) {
      return res.status(404).json({ success: false, message: "Chat participant not found." });
    }

    const hrData = await getHrDataDoc();
    const participantSet = [currentUserId, toUserId].sort().join(":");
    const chatIndex = hrData.chats.findIndex(
      (chat) => chat.participants.slice().sort().join(":") === participantSet
    );
    const newMessage = {
      id: `m-${Date.now()}`,
      from: currentUserId,
      text: text.trim(),
      createdAt: new Date().toISOString()
    };

    if (chatIndex >= 0) {
      hrData.chats[chatIndex].messages.push(newMessage);
    } else {
      hrData.chats.push({
        id: `c-${Date.now()}`,
        participants: [currentUserId, toUserId],
        messages: [newMessage]
      });
    }

    hrData.notifications.unshift(
      {
        id: `n-${Date.now()}-chat`,
        userId: toUserId,
        title: "New chat message",
        message: `${sender.name} sent: ${text.trim().slice(0, 45)}${text.trim().length > 45 ? "..." : ""}`,
        channel: "app",
        status: "sent",
        createdAt: new Date().toISOString(),
        read: false
      },
      {
        id: `n-${Date.now()}-mail`,
        userId: toUserId,
        title: "Email notification",
        message: `Email queued to ${receiver.email} for new chat message.`,
        channel: "email",
        status: "sent",
        createdAt: new Date().toISOString(),
        read: false
      }
    );

    await hrData.save();
    res.json({ success: true, state: await buildBootstrapPayload(currentUserId) });
  } catch (error) {
    next(error);
  }
});

router.put("/notifications/:notificationId/read", async (req, res, next) => {
  try {
    const hrData = await getHrDataDoc();
    const notification = hrData.notifications.find((item) => item.id === req.params.notificationId);
    if (notification) {
      notification.read = true;
      await hrData.save();
    }
    res.json({ success: true, state: await buildBootstrapPayload(req.body.currentUserId || null) });
  } catch (error) {
    next(error);
  }
});

router.post("/posts", async (req, res, next) => {
  try {
    const { currentUserId, title, message, attachments = [] } = req.body;
    const currentUser = await getUserByPortalId(currentUserId);

    if (!currentUser) {
      return res.status(401).json({ success: false, message: "Unauthorized request." });
    }
    if (!title?.trim() || !message?.trim()) {
      return res.status(400).json({ success: false, message: "Title and message are required." });
    }

    const hrData = await getHrDataDoc();
    const sanitizedAttachments = sanitizePostAttachments(attachments);
    const post = ensurePostShape({
      id: `p-${Date.now()}`,
      title: title.trim(),
      summary: message.trim().slice(0, 160),
      message: message.trim(),
      author: currentUser.name,
      authorId: currentUser.id,
      createdAt: new Date().toISOString(),
      attachments: sanitizedAttachments,
      likes: [],
      comments: []
    });

    hrData.organizationPosts.unshift(post);
    const users = await User.find({ id: { $ne: currentUser.id } }).lean();
    users.forEach((user) => {
      hrData.notifications.unshift({
        id: `n-${Date.now()}-post-${user.id}-${Math.random().toString(36).slice(2, 5)}`,
        userId: user.id,
        title: `Company Post: ${post.title}`,
        message: `${currentUser.name} posted a new announcement.`,
        channel: "app",
        status: "sent",
        createdAt: new Date().toISOString(),
        read: false
      });
    });

    await hrData.save();
    res.json({ success: true, state: await buildBootstrapPayload(currentUserId), post });
  } catch (error) {
    next(error);
  }
});

router.post("/posts/:postId/like", async (req, res, next) => {
  try {
    const { currentUserId } = req.body;
    const hrData = await getHrDataDoc();
    const post = hrData.organizationPosts.find((item) => item.id === req.params.postId);
    if (!post) {
      return res.status(404).json({ success: false, message: "Post not found." });
    }

    const alreadyLiked = (post.likes || []).includes(currentUserId);
    post.likes = alreadyLiked
      ? post.likes.filter((userId) => userId !== currentUserId)
      : [...(post.likes || []), currentUserId];

    await hrData.save();
    res.json({ success: true, state: await buildBootstrapPayload(currentUserId) });
  } catch (error) {
    next(error);
  }
});

router.post("/posts/:postId/comments", async (req, res, next) => {
  try {
    const { currentUserId, text } = req.body;
    const currentUser = await getUserByPortalId(currentUserId);
    const hrData = await getHrDataDoc();
    const post = hrData.organizationPosts.find((item) => item.id === req.params.postId);

    if (!currentUser || !post || !text?.trim()) {
      return res.status(400).json({ success: false, message: "Unable to add comment." });
    }

    post.comments.push({
      id: `pc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      userId: currentUser.id,
      userName: currentUser.name,
      message: text.trim(),
      createdAt: new Date().toISOString()
    });

    await hrData.save();
    res.json({ success: true, state: await buildBootstrapPayload(currentUserId) });
  } catch (error) {
    next(error);
  }
});

router.post("/regularizations", async (req, res, next) => {
  try {
    const { currentUserId, date, reason, recipientUserId = null } = req.body;
    if (!date || !reason?.trim()) {
      return res.status(400).json({ success: false, message: "Date and reason are required." });
    }

    const currentUser = await getUserByPortalId(currentUserId);
    if (!currentUser) {
      return res.status(401).json({ success: false, message: "User not logged in." });
    }

    const hrData = await getHrDataDoc();
    const exists = hrData.regularizationRequests.find(
      (request) => request.userId === currentUserId && request.date === date && request.status === "Pending"
    );
    if (exists) {
      return res.status(400).json({ success: false, message: "Pending request already exists for this date." });
    }

    const recipient = recipientUserId
      ? await getUserByPortalId(recipientUserId)
      : await User.findOne({ role: "admin" });

    hrData.regularizationRequests.unshift({
      id: `rr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      userId: currentUserId,
      date,
      reason: reason.trim(),
      recipientUserId: recipient?.id || null,
      recipientEmail: recipient?.email || "",
      status: "Pending",
      createdAt: new Date().toISOString(),
      reviewedBy: null,
      reviewComment: ""
    });

    if (recipient) {
      hrData.notifications.unshift({
        id: `n-${Date.now()}-reg-${recipient.id}`,
        userId: recipient.id,
        title: "Attendance regularization request",
        message: `${currentUser.name} requested attendance regularization for ${date}.`,
        channel: "email",
        status: "sent",
        createdAt: new Date().toISOString(),
        read: false
      });
    }

    await hrData.save();
    res.json({ success: true, state: await buildBootstrapPayload(currentUserId) });
  } catch (error) {
    next(error);
  }
});

router.post("/regularizations/approve", async (req, res, next) => {
  try {
    const { currentUserId, userId, date, requestId = null, comment = "" } = req.body;
    const currentUser = await getUserByPortalId(currentUserId);
    if (!currentUser) {
      return res.status(401).json({ success: false, message: "User not logged in." });
    }
    if (!userId || !date) {
      return res.status(400).json({ success: false, message: "Employee and date are required." });
    }

    const hrData = await getHrDataDoc();
    const existingIndex = hrData.attendanceSessions.findIndex(
      (session) => session.userId === userId && session.date === date
    );

    if (existingIndex >= 0) {
      hrData.attendanceSessions[existingIndex] = {
        ...hrData.attendanceSessions[existingIndex],
        clockIn: hrData.attendanceSessions[existingIndex].clockIn || `${date}T09:00:00.000Z`,
        clockOut: `${date}T18:00:00.000Z`,
        workedMinutes: Math.max(hrData.attendanceSessions[existingIndex].workedMinutes || 0, 540)
      };
    } else {
      hrData.attendanceSessions.push({
        id: `as-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        userId,
        date,
        clockIn: `${date}T09:00:00.000Z`,
        clockOut: `${date}T18:00:00.000Z`,
        workedMinutes: 540
      });
    }

    const attendanceIndex = hrData.attendance.findIndex(
      (record) => record.userId === userId && record.date === date
    );
    if (attendanceIndex >= 0) {
      hrData.attendance[attendanceIndex].status = "Present";
    } else {
      hrData.attendance.push({
        id: `a-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        userId,
        date,
        status: "Present"
      });
    }

    if (requestId) {
      const request = hrData.regularizationRequests.find((item) => item.id === requestId);
      if (request) {
        request.status = "Approved";
        request.reviewedBy = currentUserId;
        request.reviewComment = comment || "Regularized as full day by HR/Admin.";
        request.reviewedAt = new Date().toISOString();
      }
    }

    hrData.notifications.unshift({
      id: `n-${Date.now()}-reg-approved`,
      userId,
      title: "Attendance regularized",
      message: `Your attendance for ${date} was regularized as full day.`,
      channel: "email",
      status: "sent",
      createdAt: new Date().toISOString(),
      read: false
    });

    await hrData.save();
    res.json({ success: true, state: await buildBootstrapPayload(currentUserId) });
  } catch (error) {
    next(error);
  }
});

router.put("/attendance/admin", async (req, res, next) => {
  try {
    const { currentUserId, userId, date, attendanceStatus, workDayType = "No Work Session", comment = "" } = req.body;
    if (!userId || !date || !attendanceStatus) {
      return res.status(400).json({ success: false, message: "Employee, date and attendance status are required." });
    }

    const validStatuses = ["Present", "Absent", "WFH"];
    if (!validStatuses.includes(attendanceStatus)) {
      return res.status(400).json({ success: false, message: "Invalid attendance status." });
    }

    const hrData = await getHrDataDoc();
    const attendanceIndex = hrData.attendance.findIndex(
      (record) => record.userId === userId && record.date === date
    );
    if (attendanceIndex >= 0) {
      hrData.attendance[attendanceIndex].status = attendanceStatus;
    } else {
      hrData.attendance.push({
        id: `a-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        userId,
        date,
        status: attendanceStatus
      });
    }

    hrData.attendanceSessions = hrData.attendanceSessions.filter(
      (session) => !(session.userId === userId && session.date === date)
    );

    if (attendanceStatus !== "Absent") {
      if (workDayType === "Full Day") {
        hrData.attendanceSessions.push({
          id: `as-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          userId,
          date,
          clockIn: `${date}T09:00:00.000Z`,
          clockOut: `${date}T18:00:00.000Z`,
          workedMinutes: 540
        });
      } else if (workDayType === "Half Day") {
        hrData.attendanceSessions.push({
          id: `as-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          userId,
          date,
          clockIn: `${date}T09:00:00.000Z`,
          clockOut: `${date}T14:00:00.000Z`,
          workedMinutes: 300
        });
      }
    }

    hrData.notifications.unshift({
      id: `n-${Date.now()}-attendance-admin-update`,
      userId,
      title: "Attendance updated by HR/Admin",
      message: `Attendance on ${date} updated to ${attendanceStatus}${comment ? ` (${comment})` : ""}.`,
      channel: "email",
      status: "sent",
      createdAt: new Date().toISOString(),
      read: false
    });

    await hrData.save();
    res.json({ success: true, state: await buildBootstrapPayload(currentUserId) });
  } catch (error) {
    next(error);
  }
});

router.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({
    success: false,
    message: error.message || "Server error"
  });
});

module.exports = router;

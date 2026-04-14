const HrData = require("../models/HrData");
const User = require("../models/User");
const { buildPortalMeta } = require("../config/hrPortalConfig");

const HR_KEY = "default";
const LEGACY_DEMO_EMAILS = [
  "admin@hrportal.com",
  "employee@hrportal.com",
  "sara@hrportal.com",
  "daniel@hrportal.com",
  "priya@hrportal.com",
  "manager.it@hrportal.com"
];
const LEGACY_SEEDED_USER_IDS = ["u1", "u2", "u3", "u4", "u5", "u6"];
const LEGACY_SEEDED_POST_TITLES = ["Quarterly HR Policy Update"];
const LEGACY_SEEDED_CHAT_IDS = ["c1"];
const LEGACY_SEEDED_LEAVE_IDS = ["l1", "l2"];
const LEGACY_SEEDED_ATTENDANCE_IDS = ["a1", "a2", "a3", "a4", "a5", "a6"];
const LEGACY_SEEDED_SESSION_IDS = ["as-u2-today"];
const LEGACY_SEEDED_HOLIDAY_IDS = ["h1", "h2"];

const clone = (value) => JSON.parse(JSON.stringify(value));

const getHrDataDoc = async () => {
  let hrData = await HrData.findOne({ key: HR_KEY });
  if (!hrData) {
    hrData = await HrData.create({ key: HR_KEY });
  }
  return hrData;
};

const initializePortalState = async () => {
  await getHrDataDoc();
};

const filterOutDemoReferences = (items, predicate) => (Array.isArray(items) ? items.filter(predicate) : []);

const clearHrDataCollections = (hrData) => {
  hrData.attendance = [];
  hrData.attendanceSessions = [];
  hrData.holidays = [];
  hrData.regularizationRequests = [];
  hrData.leaves = [];
  hrData.organizationPosts = [];
  hrData.salarySlips = [];
  hrData.notifications = [];
  hrData.chats = [];
  hrData.activityLogs = [];
  hrData.inviteLinks = [];
};

const hasLegacySeededHrData = (hrData) => {
  const attendanceHasSeedIds = (hrData.attendance || []).some(
    (item) => LEGACY_SEEDED_ATTENDANCE_IDS.includes(item.id) || LEGACY_SEEDED_USER_IDS.includes(item.userId)
  );
  const sessionsHaveSeedIds = (hrData.attendanceSessions || []).some(
    (item) => LEGACY_SEEDED_SESSION_IDS.includes(item.id) || LEGACY_SEEDED_USER_IDS.includes(item.userId)
  );
  const holidaysHaveSeedIds = (hrData.holidays || []).some((item) => LEGACY_SEEDED_HOLIDAY_IDS.includes(item.id));
  const leavesHaveSeedIds = (hrData.leaves || []).some(
    (item) =>
      LEGACY_SEEDED_LEAVE_IDS.includes(item.id) ||
      LEGACY_SEEDED_USER_IDS.includes(item.userId) ||
      LEGACY_SEEDED_USER_IDS.includes(item.currentApproverId)
  );
  const postsHaveSeedIds = (hrData.organizationPosts || []).some(
    (item) =>
      item.id === "p1" ||
      LEGACY_SEEDED_POST_TITLES.includes(item.title) ||
      LEGACY_SEEDED_USER_IDS.includes(item.authorId)
  );
  const chatsHaveSeedIds = (hrData.chats || []).some(
    (item) =>
      LEGACY_SEEDED_CHAT_IDS.includes(item.id) ||
      (item.participants || []).some((participantId) => LEGACY_SEEDED_USER_IDS.includes(participantId))
  );

  return attendanceHasSeedIds || sessionsHaveSeedIds || holidaysHaveSeedIds || leavesHaveSeedIds || postsHaveSeedIds || chatsHaveSeedIds;
};

const cleanupLegacyDemoData = async () => {
  const hrData = await getHrDataDoc();
  const hadLegacySeededHrData = hasLegacySeededHrData(hrData);
  const demoUsers = await User.find({ email: { $in: LEGACY_DEMO_EMAILS } }).lean();
  if (demoUsers.length === 0 && !hadLegacySeededHrData) {
    return { removedUsers: 0, cleanedDemoState: false };
  }

  const demoUserIds = new Set(demoUsers.map((user) => user.id));
  const nonDemoUserCount = await User.countDocuments({ email: { $nin: LEGACY_DEMO_EMAILS } });

  if (demoUsers.length > 0) {
    await User.deleteMany({ email: { $in: LEGACY_DEMO_EMAILS } });
  }

  if (hadLegacySeededHrData || nonDemoUserCount === 0) {
    clearHrDataCollections(hrData);
  } else {
    hrData.attendance = filterOutDemoReferences(
      hrData.attendance,
      (record) => !demoUserIds.has(record.userId)
    );
    hrData.attendanceSessions = filterOutDemoReferences(
      hrData.attendanceSessions,
      (session) => !demoUserIds.has(session.userId)
    );
    hrData.regularizationRequests = filterOutDemoReferences(
      hrData.regularizationRequests,
      (request) => !demoUserIds.has(request.userId) && !demoUserIds.has(request.recipientUserId)
    );
    hrData.leaves = filterOutDemoReferences(
      hrData.leaves,
      (leave) =>
        !demoUserIds.has(leave.userId) &&
        !demoUserIds.has(leave.currentApproverId) &&
        !(leave.approvalFlow || []).some((step) => demoUserIds.has(step.approverId))
    );
    hrData.organizationPosts = filterOutDemoReferences(
      hrData.organizationPosts,
      (post) => !demoUserIds.has(post.authorId)
    );
    hrData.salarySlips = filterOutDemoReferences(
      hrData.salarySlips,
      (slip) => !demoUserIds.has(slip.userId)
    );
    hrData.notifications = filterOutDemoReferences(
      hrData.notifications,
      (notification) => !demoUserIds.has(notification.userId)
    );
    hrData.chats = filterOutDemoReferences(
      hrData.chats,
      (chat) => !(chat.participants || []).some((participantId) => demoUserIds.has(participantId))
    );
    hrData.activityLogs = filterOutDemoReferences(
      hrData.activityLogs,
      (entry) => !demoUserIds.has(entry.userId)
    );
    hrData.inviteLinks = filterOutDemoReferences(
      hrData.inviteLinks,
      (invite) =>
        !demoUserIds.has(invite.userId) &&
        !demoUserIds.has(invite.createdBy) &&
        !LEGACY_DEMO_EMAILS.includes((invite.email || "").toLowerCase())
    );
  }

  await hrData.save();
  return { removedUsers: demoUsers.length, cleanedDemoState: true };
};

const loadAppState = async () => {
  const [users, hrDataDoc] = await Promise.all([
    User.find().sort({ createdAt: 1 }),
    getHrDataDoc()
  ]);

  return {
    users: users.map((user) => clone(user.toObject())),
    hrData: clone(hrDataDoc.toObject())
  };
};

const buildBootstrapPayload = async (currentUserId = null) => {
  const { users, hrData } = await loadAppState();
  const validCurrentUserId = users.some((user) => user.id === currentUserId) ? currentUserId : null;

  return {
    currentUserId: validCurrentUserId,
    meta: buildPortalMeta(users),
    users,
    attendance: hrData.attendance || [],
    attendanceSessions: hrData.attendanceSessions || [],
    holidays: hrData.holidays || [],
    regularizationRequests: hrData.regularizationRequests || [],
    leaves: hrData.leaves || [],
    organizationPosts: hrData.organizationPosts || [],
    salarySlips: hrData.salarySlips || [],
    notifications: hrData.notifications || [],
    chats: hrData.chats || [],
    activityLogs: hrData.activityLogs || [],
    inviteLinks: hrData.inviteLinks || []
  };
};

module.exports = {
  buildBootstrapPayload,
  cleanupLegacyDemoData,
  getHrDataDoc,
  initializePortalState,
  loadAppState,
  LEGACY_DEMO_EMAILS
};

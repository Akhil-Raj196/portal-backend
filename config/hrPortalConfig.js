const ROLE_PERMISSIONS = {
  admin: [
    "dashboard",
    "attendance",
    "regularize",
    "profile",
    "leave",
    "salary",
    "payroll_admin",
    "chat",
    "notifications",
    "access",
    "company_posts"
  ],
  employee: ["dashboard", "attendance", "profile", "leave", "salary", "chat", "notifications"]
};

const PORTAL_OPTION_DEFAULTS = {
  leaveTypes: ["Paid Leave", "PH Leave", "Casual Leave", "Sick Leave", "Unpaid Leave"],
  dayTypes: ["Full Day", "Half Day"],
  attendanceStatuses: ["Present", "Absent", "WFH"],
  workDayTypes: ["Full Day", "Half Day", "No Work Session"],
  roleOptions: ["employee", "admin"],
  currencyOptions: ["USD", "INR", "EUR", "GBP", "AED", "SGD"]
};

const getUniqueSortedValues = (values = []) =>
  Array.from(
    new Set(
      values
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter(Boolean)
    )
  ).sort((left, right) => left.localeCompare(right));

const buildPortalMeta = (users = []) => ({
  rolePermissions: ROLE_PERMISSIONS,
  permissionOptions: ROLE_PERMISSIONS.admin,
  leaveTypes: PORTAL_OPTION_DEFAULTS.leaveTypes,
  dayTypes: PORTAL_OPTION_DEFAULTS.dayTypes,
  attendanceStatuses: PORTAL_OPTION_DEFAULTS.attendanceStatuses,
  workDayTypes: PORTAL_OPTION_DEFAULTS.workDayTypes,
  roleOptions: PORTAL_OPTION_DEFAULTS.roleOptions,
  currencyOptions: PORTAL_OPTION_DEFAULTS.currencyOptions,
  departments: getUniqueSortedValues(users.map((user) => user.department)),
  designations: getUniqueSortedValues(users.map((user) => user.designation))
});

module.exports = {
  ROLE_PERMISSIONS,
  PORTAL_OPTION_DEFAULTS,
  buildPortalMeta
};

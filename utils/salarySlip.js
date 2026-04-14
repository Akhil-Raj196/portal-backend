const COMPANY_NAME = "Ingenious HR Portal Pvt. Ltd.";

const toDateString = (date) => {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const monthLabel = (year, monthIndex) =>
  new Date(year, monthIndex, 1).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric"
  });

const getPeriodKey = (year, monthIndex) => `${year}-${`${monthIndex + 1}`.padStart(2, "0")}`;

const getCurrentMonthPeriod = (referenceDate = new Date()) => ({
  year: referenceDate.getFullYear(),
  monthIndex: referenceDate.getMonth(),
  key: getPeriodKey(referenceDate.getFullYear(), referenceDate.getMonth()),
  label: monthLabel(referenceDate.getFullYear(), referenceDate.getMonth())
});

const getSalaryTemplate = (user) => {
  const payroll = user?.payrollDetails || {};
  const ctcAnnual = Number(payroll.ctcAnnual || 0);
  const fallbackMonthly = 6000;
  const grossMonthly = ctcAnnual > 0 ? Math.round(ctcAnnual / 12) : fallbackMonthly;

  return {
    grossMonthly,
    basicPct: Number(payroll.basicPct || 40) / 100,
    hraPct: Number(payroll.hraPct || 20) / 100,
    conveyanceFixed: Number(payroll.conveyanceFixed || 0),
    medicalFixed: Number(payroll.medicalFixed || 0),
    specialAllowanceFixed: Number(payroll.specialAllowanceFixed || 0),
    otherAllowanceFixed: Number(payroll.otherAllowanceFixed || 0),
    pfRate: Number(payroll.pfRate || 12) / 100,
    esiRate: Number(payroll.esiRate || 0.75) / 100,
    professionalTax: Number(payroll.professionalTax || 200),
    tds: Number(payroll.tds || 0),
    loanDeduction: Number(payroll.loanDeduction || 0)
  };
};

const getDaysInMonth = (year, monthIndex) => new Date(year, monthIndex + 1, 0).getDate();
const isWeekend = (date) => date.getDay() === 0 || date.getDay() === 6;

const getApprovedLeaveCredit = (userId, dateStr, leaves = []) => {
  const leave = leaves.find(
    (item) =>
      item.userId === userId &&
      item.status === "Approved" &&
      item.fromDate <= dateStr &&
      item.toDate >= dateStr
  );
  if (!leave) return 0;
  return leave.dayType === "Half Day" ? 0.5 : 1;
};

const getAttendanceCredit = (userId, dateStr, attendanceSessions = []) => {
  const workedMinutes = attendanceSessions
    .filter((session) => session.userId === userId && session.date === dateStr)
    .reduce((sum, session) => sum + (session.workedMinutes || 0), 0);

  if (workedMinutes >= 540) return 1;
  if (workedMinutes >= 300) return 0.5;
  if (workedMinutes > 0) return 0.5;
  return 0;
};

const computeSalarySlipForPeriod = ({
  user,
  attendanceSessions = [],
  leaves = [],
  holidays = [],
  year,
  monthIndex,
  generatedAt = new Date().toISOString()
}) => {
  const period = {
    year,
    monthIndex,
    key: getPeriodKey(year, monthIndex),
    label: monthLabel(year, monthIndex)
  };

  const holidaySet = new Set(
    holidays
      .map((holiday) => holiday.date)
      .filter((date) => {
        const parsed = new Date(`${date}T00:00:00`);
        return !Number.isNaN(parsed.getTime()) && parsed.getMonth() === monthIndex && parsed.getFullYear() === year;
      })
  );

  const daysInMonth = getDaysInMonth(year, monthIndex);
  let workingDays = 0;
  let paidDays = 0;

  for (let day = 1; day <= daysInMonth; day += 1) {
    const dateObj = new Date(year, monthIndex, day);
    const dateStr = toDateString(dateObj);
    if (isWeekend(dateObj) || holidaySet.has(dateStr)) continue;

    workingDays += 1;

    const leaveCredit = getApprovedLeaveCredit(user.id, dateStr, leaves);
    if (leaveCredit > 0) {
      paidDays += leaveCredit;
      continue;
    }

    paidDays += getAttendanceCredit(user.id, dateStr, attendanceSessions);
  }

  const salaryTemplate = getSalaryTemplate(user);
  const payroll = user?.payrollDetails || {};
  const currency = payroll.currency || "USD";
  const attendanceFactor = workingDays > 0 ? Math.min(Math.max(paidDays / workingDays, 0), 1) : 0;

  const grossMonthly = salaryTemplate.grossMonthly;
  const targetGross = Math.round(grossMonthly * attendanceFactor);
  const basic = Math.round(targetGross * salaryTemplate.basicPct);
  const hra = Math.round(targetGross * salaryTemplate.hraPct);
  let conveyance = Math.round(salaryTemplate.conveyanceFixed * attendanceFactor);
  let medical = Math.round(salaryTemplate.medicalFixed * attendanceFactor);
  let specialAllowance = Math.round(salaryTemplate.specialAllowanceFixed * attendanceFactor);
  let otherAllowance = Math.round(salaryTemplate.otherAllowanceFixed * attendanceFactor);

  if (
    salaryTemplate.conveyanceFixed === 0 &&
    salaryTemplate.medicalFixed === 0 &&
    salaryTemplate.specialAllowanceFixed === 0 &&
    salaryTemplate.otherAllowanceFixed === 0
  ) {
    conveyance = Math.round(targetGross * 0.1);
    medical = Math.round(targetGross * 0.08);
    specialAllowance = 0;
    otherAllowance = 0;
  }

  let gross = basic + hra + conveyance + medical + specialAllowance + otherAllowance;
  if (gross < targetGross) {
    otherAllowance += targetGross - gross;
    gross = targetGross;
  }

  const pf = payroll.pfNumber ? Math.round(basic * salaryTemplate.pfRate) : 0;
  const esi = payroll.esiNumber && gross <= 21000 ? Math.round(gross * salaryTemplate.esiRate) : 0;
  const professionalTax = gross > 0 ? salaryTemplate.professionalTax : 0;
  const tds = Math.round(salaryTemplate.tds * attendanceFactor);
  const loanDeduction = Math.round(salaryTemplate.loanDeduction * attendanceFactor);
  const totalDeductions = pf + esi + professionalTax + tds + loanDeduction;
  const net = Math.max(gross - totalDeductions, 0);

  return {
    id: `slip-${user.id}-${period.key}`,
    userId: user.id,
    companyName: COMPANY_NAME,
    month: period.label,
    period,
    currency,
    generatedOn: generatedAt,
    employeeProfile: {
      firstName: payroll.firstName || (user?.name || "").split(" ")[0] || "",
      lastName: payroll.lastName || (user?.name || "").split(" ").slice(1).join(" "),
      employeeCode: payroll.employeeCode || user?.personalDetails?.employeeCode || "",
      pfNumber: payroll.pfNumber || "",
      esiNumber: payroll.esiNumber || "",
      accountNumber: payroll.accountNumber || "",
      ifscCode: payroll.ifscCode || "",
      bankName: payroll.bankName || "",
      ctcAnnual: Number(payroll.ctcAnnual || 0),
      currency,
      basicPct: Number(payroll.basicPct || 40),
      hraPct: Number(payroll.hraPct || 20),
      conveyanceFixed: Number(payroll.conveyanceFixed || 0),
      medicalFixed: Number(payroll.medicalFixed || 0),
      specialAllowanceFixed: Number(payroll.specialAllowanceFixed || 0),
      otherAllowanceFixed: Number(payroll.otherAllowanceFixed || 0),
      pfRate: Number(payroll.pfRate || 12),
      esiRate: Number(payroll.esiRate || 0.75),
      professionalTax: Number(payroll.professionalTax || 200),
      tds: Number(payroll.tds || 0),
      loanDeduction: Number(payroll.loanDeduction || 0)
    },
    attendanceSummary: {
      workingDays,
      paidDays: Number(paidDays.toFixed(1)),
      lopDays: Number(Math.max(workingDays - paidDays, 0).toFixed(1))
    },
    earnings: {
      basic,
      hra,
      conveyance,
      medical,
      specialAllowance,
      otherAllowance,
      gross
    },
    deductions: {
      pf,
      esi,
      professionalTax,
      tds,
      loanDeduction,
      total: totalDeductions
    },
    net,
    basic,
    allowances: gross - basic,
    deductionsTotal: totalDeductions
  };
};

module.exports = {
  computeSalarySlipForPeriod,
  getCurrentMonthPeriod
};

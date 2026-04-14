let nodemailer = null;

try {
  // Optional dependency. If unavailable, the backend still runs and reports email delivery as unavailable.
  // eslint-disable-next-line global-require, import/no-extraneous-dependencies
  nodemailer = require("nodemailer");
} catch (error) {
  nodemailer = null;
}

const getMailerConfig = () => ({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: String(process.env.SMTP_SECURE || "false") === "true",
  user: process.env.SMTP_USER,
  pass: process.env.SMTP_PASS,
  from: process.env.SMTP_FROM || process.env.SMTP_USER || ""
});

const isMailerConfigured = () => {
  const config = getMailerConfig();
  return Boolean(nodemailer && config.host && config.port && config.user && config.pass && config.from);
};

const sendInviteCredentialsEmail = async ({ to, employeeName, loginUrl, tempPassword }) => {
  if (!nodemailer) {
    return {
      delivered: false,
      message:
        "Email dependency not installed. Approve installing nodemailer or add another mail transport."
    };
  }

  const config = getMailerConfig();
  if (!config.host || !config.user || !config.pass || !config.from) {
    return {
      delivered: false,
      message: "SMTP is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and SMTP_FROM."
    };
  }

  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: {
      user: config.user,
      pass: config.pass
    }
  });

  await transporter.sendMail({
    from: config.from,
    to,
    subject: "Your Ingenious Portal account is ready",
    text: [
      `Hello ${employeeName},`,
      "",
      "Your employee portal account has been created.",
      `Login URL: ${loginUrl}`,
      `Temporary Password: ${tempPassword}`,
      "",
      "Use this password only for your first login. You will be required to set a new password immediately after signing in.",
      "",
      "Ingenious HR Portal"
    ].join("\n")
  });

  return {
    delivered: true,
    message: "Invite email sent successfully."
  };
};

module.exports = {
  isMailerConfigured,
  sendInviteCredentialsEmail
};

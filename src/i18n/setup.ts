// English source catalog namespace: setup section.
// Split from src/i18n.ts with zero text changes.
export const setup = {
  title: "Add your email",
  intro: "Choose an account. Password stays in your computer’s secure vault.",
  progress: "Setup progress",
  chooseAccount: "Choose account",
  signIn: "Sign in securely",
  recommended: "Recommended",
  icloud: "iCloud Mail",
  icloudRecommended: "iCloud Mail address and app-specific password",
  other: "Other email account",
  otherDetail: "Find secure settings or enter IMAP and SMTP yourself",
  supportedProviders:
    "Built-in help for Fastmail, Yahoo, AOL, Zoho, mailbox.org, and GMX.",
  privacy: "No tracking. No Postal Snap cloud.",
  displayTitle: "Display",
  displayHint: "Updates right away. Change it anytime in Settings.",
  saveFailed: "Could not save that change, so it was undone. Try again.",
  openSettings: "Open Settings",
  connectIcloud: "Connect iCloud Mail",
  connectOther: "Connect another account",
  connectProvider: (name: string) => `Connect ${name}`,
  icloudIntro:
    "Sign in with your iCloud Mail address and an app-specific password.",
  discoverIntro:
    "Enter your email address. Postal Snap checks built-in providers, your domain’s mail records, and your domain’s own secure settings file.",
  findSettings: "Find settings",
  findingSettings: "Finding secure settings…",
  settingsFound: (name: string) =>
    `Secure settings found for ${name}. Review them below.`,
  settingsNotFound:
    "Postal Snap could not find secure settings. Enter the server settings manually.",
  normalPasswordWarning:
    "Do not use your normal Apple Account password. iCloud Mail needs an app-specific password.",
  providerPasswordWarning: (name: string) =>
    `${name} needs an app-specific password when a mail app connects.`,
  createAppPassword: "Create app-specific password",
  helpLinkDeclined: "Help page not opened.",
  helpLinkFailed:
    "Postal Snap could not open that help page. Open support.apple.com in your browser.",
  providerHelpLinkFailed:
    "Postal Snap could not open the provider’s app-password help page.",
  icloudEmailHint:
    "Use the iCloud Mail address (@icloud.com, @me.com, or @mac.com), even if your Apple ID is different.",
  appPasswordHint:
    "Apple shows this as 16 characters, often in four groups. Spaces are removed automatically.",
  providerAppPasswordHint: (name: string) =>
    `Create an app-specific password in your ${name} account, then paste it here.`,
  appPasswordPlaceholder: "xxxx-xxxx-xxxx-xxxx",
  icloudServers: "Postal Snap uses Apple’s iCloud mail servers.",
  yourName: "Your name",
  namePlaceholder: "Jane Smith",
  email: "Email address",
  icloudEmailPlaceholder: "jane@icloud.com",
  emailPlaceholder: "jane@example.com",
  appPassword: "App-specific password",
  emailPassword: "Email password",
  showPassword: "Show password",
  hidePassword: "Hide password",
  incoming: "Incoming IMAP",
  outgoing: "Outgoing SMTP",
  server: "Server",
  serverPlaceholder: "mail.example.com",
  port: "Port",
  security: "Security",
  tls: "TLS",
  username: "Username",
  usernamePlaceholder: "Usually your full email address",
  startTls: "STARTTLS required",
  connecting: "Connecting…",
  connect: "Connect securely",
  testing: "Testing secure incoming and outgoing connections…",
  connected: "Connected securely. Your mail is ready.",
  downloadMail: "Mail to keep downloaded",
  downloadRecent: "Recent mail",
  downloadRecentHelp: "Keep message bodies from the last 90 days, up to 1 GB.",
  downloadAll: "Download all mail",
  downloadAllHelp:
    "Keep every message body. Storage use can grow without a limit.",
  gettingMail: "Getting your mail…",
  gettingMailIntro:
    "Your account is connected. Postal Snap is downloading mail in the background.",
  mailDownloadProgress: "Mail download progress",
  openMailbox: "Open mailbox",
  authHintIcloud:
    "Create a new app-specific password at appleid.apple.com, then paste it here. Your regular Apple Account password will not work.",
  authHintManual:
    "Check the username, password, server names, ports, and TLS settings. Usernames are often the full email address.",
  connectionHint:
    "Check the server name, port, and that this computer can reach the internet.",
  welcomeTitle: "Welcome to Postal Snap",
  welcomeIntro:
    "A calm email app with no tracking and no cloud. First choose how Postal Snap looks and feels, then add your email.",
  welcomeComfort:
    "Comfortable is larger and easier to scan. You can change this later in Settings.",
  steps: "Setup steps",
  stepWelcome: "Welcome",
  stepAppearance: "Appearance",
  stepComfort: "Comfort",
  stepAccount: "Account",
  continue: "Continue",
  backToSetup: "Back to setup",
  appearanceTitle: "Choose how mail looks",
  appearanceIntro:
    "Pick Auto to follow your system, or lock Light or Dark. Pick Comfortable for larger rows or Compact for a denser list. The whole window and the preview below update right away.",
  comfortTitle: "Make it comfortable",
  comfortIntro:
    "These stay in Settings too. Reported-threat checks stay on for safety and are changed only in Advanced.",
  accountTitle: "Add your email",
  accountIntro:
    "Add one account now. You can add more later. Password stays in your computer’s secure vault.",
  settingsRestored:
    "Damaged settings were restored to safe defaults. Review the choices below, then continue.",
  previewInbox: "Inbox preview",
  previewSubject: "Subject line stays readable",
  previewSender: "Sam Rivera",
  previewLive:
    "Live preview. It follows your theme, spacing, text size, and reading pane.",
  previewFolders: "Mailboxes",
  previewReadingBottom: "Reading pane below",
  previewReadingHidden: "Message opens over the list",
  previewReadingRight: "Reading pane on the right",
  comfortLargeText:
    "Large text with Compact needs more room. Try the over-list reader below.",
} as const;

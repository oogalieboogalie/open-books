/**
 * Built-in merchant and keyword knowledge. Each entry maps words that appear in
 * a normalized bank description to a category, with a confidence that reflects
 * how ambiguous the merchant is (a gas station is almost always car & truck; a
 * Walmart run could be anything).
 *
 * `direction` limits an entry to money in ("in") or money out ("out"). Entries
 * without one apply both ways; money coming back from an expense merchant is
 * treated as a refund in the same category.
 *
 * Contributions welcome: add merchants here and a test in tests/categorize.test.ts.
 */

export interface KeywordEntry {
  category: string;
  confidence: number;
  direction?: "in" | "out";
  keywords: string[];
}

export const KEYWORD_RULES: KeywordEntry[] = [
  // Income
  {
    category: "gross_receipts",
    confidence: 0.85,
    direction: "in",
    keywords: [
      "STRIPE", "STRIPE TRANSFER", "SQUARE INC", "SQUARE", "SHOPIFY", "SHOPIFY PAYOUT", "ETSY", "ETSY DEPOSIT",
      "PAYPAL TRANSFER", "AMAZON PAYMENTS", "AMAZON MARKETPLACE", "GUMROAD", "PATREON", "SUBSTACK", "UPWORK ESCROW",
      "FIVERR", "INVOICE", "CLIENT PAYMENT", "QUICKBOOKS PAYMENTS", "INTUIT PAYMENTS", "HONEYBOOK", "TOAST INC",
    ],
  },
  { category: "gross_receipts", confidence: 0.6, direction: "in", keywords: ["DEPOSIT", "MOBILE DEPOSIT", "REMOTE DEPOSIT", "WIRE IN", "INCOMING WIRE"] },

  { category: "other_income", confidence: 0.6, direction: "in", keywords: ["INTEREST PAID", "INTEREST PAYMENT", "INTEREST EARNED", "INTEREST CREDIT"] },

  // Payment processors charging fees or reversing payouts
  {
    category: "commissions_fees",
    confidence: 0.85,
    direction: "out",
    keywords: ["STRIPE", "STRIPE FEE", "SQUARE FEE", "SQUARE INC", "PAYPAL FEE", "MERCHANT FEE", "MERCHANT SERVICE", "ETSY FEES", "ETSY", "EBAY FEES", "CLOVER", "TOAST INC"],
  },

  // Transfers and card payments
  {
    category: "transfer",
    confidence: 0.85,
    keywords: [
      "TRANSFER", "ONLINE TRANSFER", "XFER", "INTERNAL TRANSFER", "PAYMENT THANK YOU", "AUTOPAY", "AUTO PAY",
      "CREDIT CARD PAYMENT", "CARDMEMBER SERV", "AMEX EPAYMENT", "AMERICAN EXPRESS ACH PMT", "CHASE CREDIT CRD",
      "DISCOVER E-PAYMENT", "CAPITAL ONE ONLINE PMT", "CITI AUTOPAY", "BANK OF AMERICA CREDIT CARD",
    ],
  },

  // Taxes the owner pays personally
  { category: "income_tax_payment", confidence: 0.9, keywords: ["IRS USATAXPYMT", "USATAXPYMT", "IRS TREAS", "EFTPS", "ESTIMATED TAX"] },
  { category: "income_tax_payment", confidence: 0.5, keywords: ["FRANCHISE TAX BD", "DEPT OF REVENUE", "DEPARTMENT OF REVENUE", "STATE TAX"] },

  // Advertising
  {
    category: "advertising",
    confidence: 0.95,
    keywords: [
      "GOOGLE ADS", "ADWORDS", "FACEBK", "FACEBOOK ADS", "META ADS", "FB ADS", "INSTAGRAM ADS", "LINKEDIN ADS",
      "TWITTER ADS", "X ADS", "TIKTOK ADS", "PINTEREST ADS", "REDDIT ADS", "BING ADS", "MICROSOFT ADS", "YELP",
      "NEXTDOOR", "THUMBTACK", "ANGI", "HOMEADVISOR", "VISTAPRINT", "MOO PRINT", "STICKER MULE", "MAILCHIMP",
      "CONSTANT CONTACT", "KLAVIYO",
    ],
  },

  // Car & truck
  {
    category: "car_truck",
    confidence: 0.9,
    direction: "out",
    keywords: [
      "SHELL", "SHELL OIL", "CHEVRON", "EXXON", "EXXONMOBIL", "MOBIL", "BP", "TEXACO", "VALERO", "SUNOCO", "CITGO",
      "SPEEDWAY", "ARCO", "MARATHON PETRO", "PHILLIPS 66", "CONOCO", "CIRCLE K", "QUIKTRIP", "QT", "RACETRAC",
      "SHEETZ", "WAWA", "KUM & GO", "CASEYS", "LOVE'S", "PILOT", "FLYING J", "MURPHY USA", "COSTCO GAS", "SAMS FUEL",
      "JIFFY LUBE", "VALVOLINE", "AUTOZONE", "O'REILLY AUTO", "ADVANCE AUTO", "NAPA", "PEP BOYS", "FIRESTONE",
      "DISCOUNT TIRE", "MIDAS", "MEINEKE", "CAR WASH", "PARKING", "PARKMOBILE", "SPOTHERO", "PAYBYPHONE", "TOLL",
      "E-ZPASS", "EZPASS", "FASTRAK", "SUNPASS", "TXTAG", "PEACH PASS", "I-PASS",
    ],
  },
  { category: "car_truck", confidence: 0.6, direction: "out", keywords: ["FUEL", "GAS STATION", "AUTO REPAIR", "OIL CHANGE"] },

  // Contract labor
  { category: "contract_labor", confidence: 0.85, direction: "out", keywords: ["UPWORK", "FIVERR", "TOPTAL", "99DESIGNS", "FREELANCER.COM", "CONTRACTOR"] },

  // Equipment (usually depreciated or expensed under Section 179)
  { category: "depreciation", confidence: 0.6, keywords: ["APPLE STORE", "APPLE.COM/US", "BEST BUY", "BESTBUY", "DELL", "B&H PHOTO", "MICRO CENTER", "LENOVO", "NEWEGG"] },

  // Insurance
  {
    category: "insurance",
    confidence: 0.85,
    keywords: ["HISCOX", "NEXT INSURANCE", "THE HARTFORD", "HARTFORD", "THIMBLE", "EMBROKER", "COVERWALLET", "BIBERK", "COMMERCIAL INSURANCE", "LIABILITY INSURANCE"],
  },
  { category: "insurance", confidence: 0.5, keywords: ["INSURANCE", "STATE FARM", "PROGRESSIVE", "GEICO", "ALLSTATE", "LIBERTY MUTUAL", "NATIONWIDE", "FARMERS INS"] },

  // Self-employed health insurance
  {
    category: "se_health_insurance",
    confidence: 0.75,
    direction: "out",
    keywords: ["BLUE CROSS", "BLUE SHIELD", "BCBS", "AETNA", "CIGNA", "UNITEDHEALTH", "UNITED HEALTHCARE", "UHC", "KAISER", "HUMANA", "AMBETTER", "OSCAR HEALTH", "HEALTHCARE.GOV", "DELTA DENTAL"],
  },

  // Owner retirement contributions
  { category: "retirement_owner", confidence: 0.6, direction: "out", keywords: ["SEP IRA", "SOLO 401K", "SIMPLE IRA"] },

  // Interest
  { category: "interest_other", confidence: 0.85, direction: "out", keywords: ["INTEREST CHARGE", "FINANCE CHARGE", "PURCHASE INTEREST", "INTEREST CHARGED"] },

  // Loans
  { category: "loan", confidence: 0.7, keywords: ["SBA LOAN", "LOAN PAYMENT", "LOAN PROCEEDS", "KABBAGE", "ONDECK", "BLUEVINE LOAN", "FUNDBOX"] },

  // Legal & professional
  {
    category: "legal_professional",
    confidence: 0.85,
    direction: "out",
    keywords: [
      "LEGALZOOM", "ROCKET LAWYER", "INCFILE", "ZENBUSINESS", "NORTHWEST REGISTERED", "REGISTERED AGENT", "ATTORNEY",
      "LAW OFFICE", "LAW OFFICES", "LAW FIRM", "LAW GROUP", "CPA", "ACCOUNTING", "BOOKKEEPING", "TAX PREP", "H&R BLOCK",
      "PILOT.COM", "BENCH ACCOUNTING",
    ],
  },

  // Office expense
  {
    category: "office_expense",
    confidence: 0.8,
    direction: "out",
    keywords: ["STAPLES", "OFFICE DEPOT", "OFFICEMAX", "USPS", "POST OFFICE", "POSTAGE", "STAMPS.COM", "PIRATE SHIP", "PIRATESHIP", "SHIPSTATION", "UPS STORE", "THE UPS STORE", "FEDEX OFFICE", "FEDEX", "UPS", "DHL"],
  },

  // Rent
  { category: "rent_property", confidence: 0.85, direction: "out", keywords: ["WEWORK", "REGUS", "INDUSTRIOUS", "SPACES", "PUBLIC STORAGE", "EXTRA SPACE", "CUBESMART", "LIFE STORAGE", "OFFICE RENT", "COWORKING"] },
  { category: "rent_property", confidence: 0.5, direction: "out", keywords: ["RENT", "LEASE"] },
  { category: "rent_equipment", confidence: 0.8, direction: "out", keywords: ["U-HAUL", "UHAUL", "SUNBELT RENTALS", "UNITED RENTALS", "TOOL RENTAL", "EQUIPMENT RENTAL", "PENSKE"] },

  // Repairs
  { category: "repairs", confidence: 0.7, direction: "out", keywords: ["REPAIR", "REPAIRS", "HANDYMAN", "GEEK SQUAD", "UBREAKIFIX", "PLUMBING", "ELECTRICIAN", "HVAC"] },

  // Supplies
  { category: "supplies", confidence: 0.75, keywords: ["HOME DEPOT", "THE HOME DEPOT", "LOWES", "LOWE'S", "HARBOR FREIGHT", "ULINE", "GRAINGER", "MENARDS", "ACE HARDWARE", "MICHAELS", "JOANN", "HOBBY LOBBY"] },
  { category: "supplies", confidence: 0.5, keywords: ["AMAZON", "AMZN", "AMAZON.COM", "AMZN MKTP", "WALMART", "WAL-MART", "TARGET", "COSTCO", "SAMS CLUB", "DOLLAR TREE", "DOLLAR GENERAL"] },

  // Taxes & licenses
  {
    category: "taxes_licenses",
    confidence: 0.8,
    direction: "out",
    keywords: ["SECRETARY OF STATE", "SEC OF STATE", "SOS ANNUAL REPORT", "ANNUAL REPORT FEE", "BUSINESS LICENSE", "CITY LICENSE", "PERMIT", "PERMITS", "DIVISION OF CORPORATIONS", "PROPERTY TAX", "SALES TAX"],
  },

  // Travel
  {
    category: "travel",
    confidence: 0.85,
    keywords: [
      "DELTA AIR", "DELTA", "UNITED AIRLINES", "UNITED AIR", "AMERICAN AIRLINES", "AMERICAN AIR", "SOUTHWEST AIRLINES",
      "SOUTHWES", "SOUTHWEST", "JETBLUE", "ALASKA AIR", "SPIRIT AIRL", "FRONTIER AIRLINES", "HAWAIIAN AIRL",
      "AIR CANADA", "AIRBNB", "VRBO", "MARRIOTT", "HILTON", "HYATT", "IHG", "HOLIDAY INN", "HAMPTON INN",
      "COURTYARD", "SHERATON", "WESTIN", "BEST WESTERN", "LA QUINTA", "MOTEL 6", "EXPEDIA", "BOOKING.COM",
      "HOTELS.COM", "PRICELINE", "KAYAK", "HOTWIRE", "AMTRAK", "GREYHOUND", "HERTZ", "AVIS", "ENTERPRISE RENT",
      "BUDGET RENT", "NATIONAL CAR", "ALAMO", "SIXT", "TURO", "TSA PRECHECK", "HOTEL", "MOTEL", "AIRLINES",
      "AIRWAYS", "AIRPORT",
    ],
  },
  { category: "travel", confidence: 0.55, direction: "out", keywords: ["UBER", "UBER TRIP", "LYFT", "TAXI", "CAB"] },

  // Meals
  {
    category: "meals",
    confidence: 0.85,
    keywords: [
      "STARBUCKS", "DUNKIN", "PEET'S", "PEETS", "BLUE BOTTLE", "TIM HORTONS", "PANERA", "CHIPOTLE", "MCDONALD'S",
      "MCDONALDS", "SUBWAY", "CHICK-FIL-A", "CHICK FIL A", "TACO BELL", "WENDY'S", "WENDYS", "BURGER KING",
      "SHAKE SHACK", "IN-N-OUT", "FIVE GUYS", "PANDA EXPRESS", "SWEETGREEN", "CAVA", "OLIVE GARDEN", "APPLEBEE",
      "CHILI'S", "DOMINO'S", "DOMINOS", "PIZZA HUT", "PAPA JOHN", "UBER EATS", "UBEREATS", "DOORDASH", "GRUBHUB",
      "POSTMATES", "SEAMLESS", "RESTAURANT", "CAFE", "COFFEE", "GRILL", "PIZZA", "PIZZERIA", "TAQUERIA", "BAKERY",
      "DINER", "BISTRO", "SUSHI", "BBQ", "STEAKHOUSE", "BRASSERIE", "TAVERN", "PUB", "EATERY", "DELI", "RAMEN", "BURGER",
    ],
  },
  { category: "meals", confidence: 0.6, keywords: ["KITCHEN", "BAR", "CANTINA", "TOAST"] },

  // Utilities
  {
    category: "utilities",
    confidence: 0.85,
    direction: "out",
    keywords: [
      "COMCAST", "XFINITY", "VERIZON", "VZWRLSS", "AT&T", "ATT", "T-MOBILE", "TMOBILE", "SPRINT", "SPECTRUM", "COX COMM",
      "CENTURYLINK", "FRONTIER COMM", "GOOGLE FI", "MINT MOBILE", "VISIBLE", "STARLINK", "PG&E", "CON EDISON", "CONED",
      "DUKE ENERGY", "DOMINION ENERGY", "FPL", "XCEL ENERGY", "NATIONAL GRID", "SOUTHERN CALIFORNIA EDISON", "SCE",
      "GEORGIA POWER", "ENTERGY", "WATER DEPT", "WATER UTILITY", "ELECTRIC", "UTILITIES", "INTERNET",
    ],
  },

  // Wages and payroll providers
  { category: "wages", confidence: 0.75, direction: "out", keywords: ["GUSTO", "ADP", "PAYCHEX", "RIPPLING", "ONPAY", "PAYROLL", "SQUARE PAYROLL", "QUICKBOOKS PAYROLL", "INTUIT PAYROLL"] },

  // Software & subscriptions
  {
    category: "software",
    confidence: 0.9,
    keywords: [
      "AMAZON WEB SERVICES", "AWS", "ADOBE", "MICROSOFT", "MSFT", "OFFICE 365", "GOOGLE WORKSPACE", "GSUITE",
      "GOOGLE GSUITE", "GOOGLE STORAGE", "GOOGLE ONE", "GOOGLE CLOUD", "DROPBOX", "BOX.COM", "SLACK", "ZOOM",
      "ZOOM.US", "NOTION", "GITHUB", "ATLASSIAN", "JIRA", "DIGITALOCEAN", "HEROKU", "VERCEL", "NETLIFY",
      "CLOUDFLARE", "GODADDY", "NAMECHEAP", "SQUARESPACE", "WIX", "WIX.COM", "WEBFLOW", "WORDPRESS", "SHOPIFY",
      "QUICKBOOKS", "INTUIT", "XERO", "FRESHBOOKS", "WAVE", "CANVA", "FIGMA", "OPENAI", "CHATGPT", "ANTHROPIC",
      "CLAUDE.AI", "1PASSWORD", "LASTPASS", "LINEAR", "HUBSPOT", "SALESFORCE", "DOCUSIGN", "CALENDLY", "ZAPIER",
      "AIRTABLE", "MONDAY.COM", "ASANA", "TRELLO", "LOOM", "GRAMMARLY", "SEMRUSH", "AHREFS", "APPLE.COM/BILL",
      "ITUNES", "LINKEDIN PREMIUM", "SURVEYMONKEY", "TYPEFORM", "JOTFORM",
    ],
  },
  { category: "software", confidence: 0.5, keywords: ["GOOGLE", "SUBSCRIPTION"] },

  // Bank fees
  {
    category: "bank_fees",
    confidence: 0.9,
    direction: "out",
    keywords: ["MONTHLY SERVICE FEE", "SERVICE FEE", "SERVICE CHARGE", "MAINTENANCE FEE", "OVERDRAFT", "NSF FEE", "WIRE FEE", "WIRE TRANSFER FEE", "ATM FEE", "FOREIGN TRANSACTION FEE", "ANNUAL FEE", "LATE FEE"],
  },

  // Education
  { category: "education", confidence: 0.8, direction: "out", keywords: ["UDEMY", "COURSERA", "SKILLSHARE", "MASTERCLASS", "LINKEDIN LEARNING", "PLURALSIGHT", "EDX", "CONFERENCE", "SEMINAR", "WORKSHOP", "EVENTBRITE", "O'REILLY MEDIA"] },

  // Dues
  { category: "dues_memberships", confidence: 0.8, direction: "out", keywords: ["CHAMBER OF COMMERCE", "MEMBERSHIP DUES", "ASSOCIATION DUES", "BNI", "ROTARY", "NAWBO", "FREELANCERS UNION"] },

  // Inventory
  { category: "cogs_purchases", confidence: 0.75, direction: "out", keywords: ["ALIBABA", "ALIEXPRESS", "FAIRE", "PRINTFUL", "PRINTIFY", "WHOLESALE", "INVENTORY"] },
];

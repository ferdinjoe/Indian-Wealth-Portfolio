const { newId } = require('./store');

// A starter portfolio for anyone trying the app out. Every bank, broker, insurer,
// jeweller, employer, property, loan, amount and date below is invented for this
// file; no row is, or is modelled on, anybody's real money. The only real-world
// names left in are public listed tickers (NVIDIA, Apple, TCS) and statutory
// scheme names (EPF, PPF, NPS, CPF), because those are what the price feeds and
// the India tax engine need in order to have something to chew on.
//
// The structure is deliberately broad: every asset class, all four country and
// currency pairs, two brokers so the equity tab has something to group by, three
// bullion rows priced off the metal feed, deposits that renew, and goals wired to
// holdings. Replace it from the Holdings and Profile screens, or erase it from
// Settings.
function seed() {
  const h = (category, name, country, currency, valueNative, extra = {}) => ({
    id: newId(),
    category,
    name,
    instrument: extra.instrument || '',
    institution: extra.institution || '',
    country,
    currency,
    units: extra.units ?? null,
    pricePerUnit: extra.pricePerUnit ?? null,
    valueNative: extra.units != null && extra.pricePerUnit != null
      ? Math.round(extra.units * extra.pricePerUnit * 100) / 100
      : valueNative,
    acquiredOn: extra.acquiredOn || null,
    maturityDate: extra.maturityDate || null,
    interestRatePct: extra.interestRatePct ?? null,
    termMonths: extra.termMonths ?? null,
    fdAutoRenew: extra.fdAutoRenew ?? null,
    metalRate: extra.metalRate || null,
    dividendYieldPct: extra.dividendYieldPct ?? null,
    indianTax: extra.indianTax || 'auto',
    costNative: extra.costNative ?? null,
    liquidityOverride: extra.liquidityOverride || null,
    notes: extra.notes || '',
  });

  const out = {
    profile: {
      salutation: 'Mr',
      fullName: 'Your Name',
      dateOfBirth: '1988-06-15',
      nationality: 'Indian',
      residenceCountry: 'SG',
      email: 'you@example.com',
      phone: '+65 8123 4567',
      maritalStatus: 'Married',
      dependants: 2,
      plannedRetirementAge: 60,
      lifeExpectancy: 90,
      monthlyExpensesNowINR: 145000,
      monthlyExpensesInRetirementINR: 180000,
      monthlyIncomeINR: 250000,
      monthlyInvestableSurplusINR: 60000,
      riskProfile: 'moderate',
      notes: 'Placeholder profile — replace with your real details on the Profile tab.',
    },
    holdings: [
      // ---- Bank accounts: India, Thailand, Singapore ----
      h('bank_account', 'Sample Bank Savings', 'IN', 'INR', 126400, { institution: 'Sample Bank' }),
      h('bank_account', 'Example Bank Salary Account', 'IN', 'INR', 74500, { institution: 'Example Bank' }),
      h('bank_account', 'Demo National Bank NRE Foreign Currency', 'IN', 'USD', 9800, { institution: 'Demo National Bank', notes: 'NRE account holding USD salary savings.' }),
      h('bank_account', 'Sample Bank Thailand Savings', 'TH', 'THB', 182000, { institution: 'Sample Bank Thailand' }),
      h('bank_account', 'Example Bank Thailand FX Savings', 'TH', 'USD', 4300, { institution: 'Example Bank Thailand' }),
      h('bank_account', 'Demo Bank Singapore Savings Account', 'SG', 'SGD', 21400, { institution: 'Demo Bank Singapore' }),
      h('bank_account', 'Sample Bank Singapore Salary Account', 'SG', 'SGD', 8600, { institution: 'Sample Bank Singapore' }),

      // ---- Fixed deposits: valueNative is the principal, maturity comes from the term ----
      h('fixed_deposit', 'Sample Bank 1Y Renewing FD', 'IN', 'INR', 400000, { institution: 'Sample Bank', interestRatePct: 6.9, acquiredOn: '2026-04-18', termMonths: 12, fdAutoRenew: true, notes: 'The bank rolls this at maturity and the interest stays inside.' }),
      h('fixed_deposit', 'Example Bank 5Y Tax Saver FD', 'IN', 'INR', 250000, { institution: 'Example Bank', interestRatePct: 6.65, acquiredOn: '2023-08-05', termMonths: 60, liquidityOverride: 'illiquid', notes: 'Five-year lock-in under Section 80C.' }),
      h('fixed_deposit', 'Demo Bank Singapore T-Bill Ladder', 'SG', 'SGD', 18000, { institution: 'Demo Bank Singapore', interestRatePct: 2.85, acquiredOn: '2025-11-02', termMonths: 9 }),
      h('fixed_deposit', 'Sample Bank Thailand 12M Deposit', 'TH', 'THB', 320000, { institution: 'Sample Bank Thailand', interestRatePct: 1.55, acquiredOn: '2026-06-01', termMonths: 12, fdAutoRenew: true }),

      // ---- Equity: two brokers, so the tab has something to group by ----
      h('equity', 'NVIDIA', 'US', 'USD', null, { instrument: 'NVDA', institution: 'Sample Brokers', units: 40, pricePerUnit: 172.35, acquiredOn: '2024-02-14', costNative: 5100, dividendYieldPct: 0.03 }),
      h('equity', 'Apple', 'US', 'USD', null, { instrument: 'AAPL', institution: 'Sample Brokers', units: 150, pricePerUnit: 228.6, acquiredOn: '2023-03-22', costNative: 27400 }),
      h('equity', 'Vanguard Total World ETF', 'US', 'USD', null, { instrument: 'VT', institution: 'Sample Brokers', units: 220, pricePerUnit: 119.4, acquiredOn: '2022-09-08', costNative: 24100, dividendYieldPct: 2.4 }),
      h('equity', 'DBS Group Holdings', 'SG', 'SGD', null, { instrument: 'D05', institution: 'Example Brokers', units: 600, pricePerUnit: 38.6, acquiredOn: '2024-06-11', costNative: 22800, dividendYieldPct: 3.2 }),
      h('equity', 'STI ETF', 'SG', 'SGD', null, { instrument: 'ES3', institution: 'Example Brokers', units: 1400, pricePerUnit: 3.92, acquiredOn: '2023-12-01', costNative: 5300, dividendYieldPct: 3.6 }),
      h('equity', 'Tata Consultancy Services', 'IN', 'INR', null, { instrument: 'TCS.NS', institution: 'Demo Securities', units: 90, pricePerUnit: 3120, acquiredOn: '2021-11-18', costNative: 236000, dividendYieldPct: 1.4 }),
      h('equity', 'Infosys', 'IN', 'INR', null, { instrument: 'BSE:INFY', institution: 'Demo Securities', units: 260, pricePerUnit: 1480, acquiredOn: '2022-05-09', costNative: 301000, dividendYieldPct: 2.2, notes: 'Board written into the ticker, the way the price feed reads it.' }),
      h('equity', 'Example Global Tech Feeder', 'IN', 'INR', null, { instrument: 'GLOBTECH', institution: 'Demo Securities', units: 1500, pricePerUnit: 96.4, acquiredOn: '2023-07-12', costNative: 118000, notes: 'A feeder fund no public feed knows, so this row shows what a hand-typed price looks like.' }),

      // ---- Bonds ----
      h('bond', 'GoI Stock 6.71% 2037', 'IN', 'INR', 620000, { instrument: 'GS 6.71% 2037', institution: 'Retail Bond Direct', interestRatePct: 6.71, maturityDate: '2037-04-21', acquiredOn: '2024-09-12' }),
      h('bond', 'US Treasury 4.50% 2035', 'US', 'USD', null, { instrument: 'UST 4.50% 2035', institution: 'Sample Brokers', units: 12, pricePerUnit: 952, interestRatePct: 4.5, maturityDate: '2035-05-15' }),
      h('bond', 'Singapore Government Securities 2.95% 2036', 'SG', 'SGD', 26000, { instrument: 'SGS 2.95% 2036', institution: 'Sample Bank Singapore', interestRatePct: 2.95, maturityDate: '2036-04-01' }),
      h('bond', 'Thai Government Bond 3.10% 2034', 'TH', 'THB', 540000, { instrument: 'LBGO 3.10% 2034', institution: 'Example Bank Thailand', interestRatePct: 3.1, maturityDate: '2034-06-16' }),

      // ---- Investment policies ----
      h('policy', 'Sample Life Child Endowment', 'IN', 'INR', 452000, { institution: 'Sample Life Assurance', interestRatePct: 5.05, acquiredOn: '2022-02-11', maturityDate: '2042-02-11', costNative: 310000, notes: 'Endowment plan; premium 40k/yr, sum assured 12L.' }),
      h('policy', 'Example Life ULIP - Equity Fund', 'IN', 'INR', 338000, { instrument: 'ULIP - Equity Fund', institution: 'Example Life Assurance', acquiredOn: '2021-10-01', maturityDate: '2041-10-01', costNative: 265000, notes: 'Allocation 80% equity / 20% debt.' }),
      h('policy', 'Demo Income Growth Plus', 'SG', 'SGD', 36500, { institution: 'Demo Income Assurance', interestRatePct: 3.8, acquiredOn: '2023-04-18', maturityDate: '2043-04-18', costNative: 31000 }),
      h('policy', 'Placeholder Term Cover (protect only)', 'IN', 'INR', 0, { institution: 'Placeholder Life', maturityDate: '2056-06-15', liquidityOverride: 'illiquid', notes: 'Pure protection: 1 Cr sum assured, no cash value.' }),

      // ---- Gold & commodities: grams priced off the live metal feed ----
      h('gold_commodity', 'Gold coins, 24K', 'IN', 'INR', null, { institution: 'Sample Jewellers', metalRate: 'gold24', units: 120, pricePerUnit: 7480, acquiredOn: '2020-11-14', costNative: 505000, notes: 'Weight in grams; the rate comes from the 24K per-gram feed.' }),
      h('gold_commodity', 'Gold jewellery, 22K', 'IN', 'INR', null, { institution: 'Sample Jewellers', metalRate: 'gold22', units: 260, pricePerUnit: 6860, acquiredOn: '2019-08-02', costNative: 940000, notes: 'Weight in grams of 22K, valued at the per-gram rate.' }),
      h('gold_commodity', 'Silver bars', 'IN', 'INR', null, { institution: 'Sample Jewellers', metalRate: 'silver', units: 3200, pricePerUnit: 92, acquiredOn: '2023-01-19', costNative: 246000, notes: 'Kilo bars, priced per gram off the silver feed.' }),
      h('gold_commodity', 'Gold ETF', 'SG', 'SGD', 15200, { instrument: 'SPDR Gold Trust', institution: 'Example Brokers', acquiredOn: '2024-03-27', costNative: 11800 }),

      // ---- Real estate ----
      h('real_estate', 'Apartment - Demo Nagar', 'IN', 'INR', 9800000, { institution: 'Registered sale deed (sample)', acquiredOn: '2019-06-20', costNative: 6400000, liquidityOverride: 'illiquid', notes: 'Rented at 28k/month.' }),
      h('real_estate', 'Condo - Riverside District', 'TH', 'THB', 3650000, { acquiredOn: '2021-02-08', costNative: 3100000, liquidityOverride: 'illiquid', notes: 'Leasehold, rented short-stay.' }),
      h('real_estate', 'Shared flat ownership stake', 'SG', 'SGD', 112000, { acquiredOn: '2024-08-15', costNative: 96000, liquidityOverride: 'illiquid', notes: 'A share in one unit, not a whole property.' }),

      // ---- Pension / small-savings schemes ----
      h('retirement_scheme', 'Employee Provident Fund', 'IN', 'INR', 1940000, { institution: 'EPFO', interestRatePct: 8.1, notes: 'UAN-linked; withdrawable on retirement.' }),
      h('retirement_scheme', 'Public Provident Fund', 'IN', 'INR', 980000, { institution: 'Post Office', interestRatePct: 7.0, maturityDate: '2032-03-31', liquidityOverride: 'illiquid', indianTax: 'exempt', notes: 'Fifteen-year lock-in, partial withdrawal from year 7.' }),
      h('retirement_scheme', 'NPS Tier-I', 'IN', 'INR', 1240000, { institution: 'Sample Pension Fund', interestRatePct: 9.0, notes: '60% lumpsum at 60, 40% annuity.' }),
      h('retirement_scheme', 'CPF (OA+SA)', 'SG', 'SGD', 74000, { institution: 'CPF Board', interestRatePct: 4.0, notes: 'Accessible from retirement age 63.' }),

      // ---- Other assets ----
      h('other_asset', 'Bitcoin', 'SG', 'USD', 13800, { institution: 'Sample Exchange', notes: 'Held in a self-custody wallet.' }),
      h('other_asset', 'Sedan (2021, sample)', 'IN', 'INR', 780000, { acquiredOn: '2021-09-05', costNative: 1120000, liquidityOverride: 'illiquid' }),
      h('other_asset', 'Loan note to a friend', 'IN', 'INR', 250000, { maturityDate: '2028-03-31' }),

      // ---- Liabilities ----
      h('liability', 'Home loan - Demo Nagar apartment', 'IN', 'INR', 3600000, { institution: 'Sample Bank', interestRatePct: 8.4, maturityDate: '2039-07-01', notes: 'EMI 62k/month.' }),
      h('liability', 'Property loan - second home', 'SG', 'SGD', 148000, { institution: 'Demo Bank Singapore', interestRatePct: 3.4, maturityDate: '2043-09-01' }),
      h('liability', 'Vehicle loan', 'TH', 'THB', 265000, { institution: 'Example Bank Thailand', interestRatePct: 5.1, maturityDate: '2029-01-01' }),
    ],
  };

  // Goals reference the sample holdings above so the goal screen shows progress
  // against assets rather than an empty link list.
  const idsFor = (...names) => out.holdings.filter((x) => names.includes(x.name)).map((x) => x.id);

  out.goals = [
    {
      id: newId(),
      name: 'Education corpus',
      purpose: 'Two degrees, inflation-linked',
      targetAmountINR: 8000000,
      targetDate: '2040-06-30',
      horizonYears: 14,
      expectedReturnPct: 11,
      inflationPct: 6,
      monthlyContributionINR: 20000,
      linkedHoldingIds: idsFor('Infosys', 'Example Life ULIP - Equity Fund'),
      notes: 'A round number to start from - set it to your own target.',
    },
    {
      id: newId(),
      name: 'Home upgrade',
      purpose: 'Bigger place, no loan',
      targetAmountINR: 12000000,
      targetDate: '2036-12-31',
      horizonYears: 10,
      expectedReturnPct: 8,
      inflationPct: 5,
      monthlyContributionINR: 12000,
      linkedHoldingIds: idsFor('Apartment - Demo Nagar', 'Shared flat ownership stake'),
      notes: 'Partly funded by selling the sample apartment.',
    },
    {
      id: newId(),
      name: 'Emergency buffer',
      purpose: '12 months of expenses, instant access',
      targetAmountINR: 2200000,
      targetDate: '2027-06-30',
      horizonYears: 1,
      expectedReturnPct: 6.5,
      inflationPct: 5,
      monthlyContributionINR: 10000,
      linkedHoldingIds: idsFor('Sample Bank Savings', 'Demo Bank Singapore Savings Account', 'Sample Bank Thailand Savings'),
      notes: 'Held only in bank accounts and short-dated deposits.',
    },
    {
      id: newId(),
      name: 'Travel fund',
      purpose: 'Two long trips in the next four years',
      targetAmountINR: 1600000,
      targetDate: '2030-05-31',
      horizonYears: 4,
      expectedReturnPct: 7,
      inflationPct: 5,
      monthlyContributionINR: 8000,
      linkedHoldingIds: [],
      notes: 'Not yet linked to any holding.',
    },
  ];

  out.settings = {
    // Deliberately not identical to the sample portfolio's actual weights:
    // property is over-owned and equity under-owned, so a fresh install shows
    // real drift on the allocation screen instead of a flat table.
    targetAllocation: {
      equity: 25,
      real_estate: 28,
      retirement_scheme: 15,
      bond: 11,
      bank_account: 8,
      fixed_deposit: 6,
      policy: 3,
      gold_commodity: 3,
      other_asset: 1,
    },
  };

  return out;
}

module.exports = { seed };

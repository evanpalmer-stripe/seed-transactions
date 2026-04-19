#!/usr/bin/env node

import Stripe from 'stripe';
import fs from 'fs';
import inquirer from 'inquirer';
import autocomplete from 'inquirer-autocomplete-prompt';

inquirer.registerPrompt('autocomplete', autocomplete);

const CONFIG_FILE = './config.json';
const MAX_SAVED_ACCOUNTS = 10;

console.log('=================================');
console.log('  Seed Payments Application  ');
console.log('=================================\n');

// ---------------------------------------------------------------------------
// Config persistence
// ---------------------------------------------------------------------------

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, 'utf8');
      const raw = JSON.parse(data);
      // Migrate old flat format → new accounts array
      if (raw && raw.pk && raw.sk && !raw.accounts) {
        const migrated = {
          accounts: [{
            name: 'Migrated account',
            pk: raw.pk,
            sk: raw.sk,
            isPlatform: false,
            connectedAccounts: [],
            lastConnectedAccountId: raw.connectedAccountId || null,
            lastRunSettings: raw.lastRunSettings || {},
            lastUsed: new Date().toISOString(),
          }],
        };
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(migrated, null, 2));
        console.log('✓ Config migrated to new multi-account format.\n');
        return migrated;
      }
      return raw;
    }
  } catch (error) {
    console.error('Error loading config:', error.message);
  }
  return { accounts: [] };
}

function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (error) {
    console.error('Error saving config:', error.message);
  }
}

function saveAccountToConfig(config, account) {
  // Upsert by SK
  const idx = config.accounts.findIndex(a => a.sk === account.sk);
  if (idx >= 0) {
    config.accounts[idx] = account;
  } else {
    config.accounts.unshift(account);
  }
  // Sort MRU first, trim to max
  config.accounts.sort((a, b) => new Date(b.lastUsed) - new Date(a.lastUsed));
  config.accounts = config.accounts.slice(0, MAX_SAVED_ACCOUNTS);
  saveConfig(config);
}

// ---------------------------------------------------------------------------
// Yes/No prompt via arrow keys (default pre-highlighted)
// ---------------------------------------------------------------------------

async function yesNo(message, defaultYes = false) {
  const { answer } = await inquirer.prompt([{
    type: 'list',
    name: 'answer',
    message,
    choices: [
      { name: 'Yes', value: true },
      { name: 'No', value: false },
    ],
    default: defaultYes ? true : false,
  }]);
  return answer;
}

// ---------------------------------------------------------------------------
// Account selection / creation
// ---------------------------------------------------------------------------

async function fetchAccountName(stripe) {
  try {
    const acct = await stripe.accounts.retrieve();
    return acct.settings?.dashboard?.display_name
      || acct.business_profile?.name
      || acct.email
      || null;
  } catch {
    return null;
  }
}

async function detectPlatform(stripe) {
  try {
    const accounts = await stripe.accounts.list({ limit: 100 });
    if (accounts.data.length === 0) return [];

    // Fetch balance + recent volume for each connected account (in batches of 10)
    const enrichAccount = async (acct) => {
      let availableBalance = 0;
      let pendingBalance = 0;
      let recentVolume = 0;
      try {
        const balance = await stripe.balance.retrieve({ stripeAccount: acct.id });
        availableBalance = balance.available.reduce((sum, b) => sum + b.amount, 0);
        pendingBalance = balance.pending.reduce((sum, b) => sum + b.amount, 0);
      } catch { /* ignore — may lack permission */ }
      try {
        // Sum successful charges in the last 30 days as a volume proxy
        const charges = await stripe.charges.list({
          limit: 100,
          created: { gte: Math.floor(Date.now() / 1000) - 30 * 86400 },
        }, { stripeAccount: acct.id });
        recentVolume = charges.data
          .filter(c => c.status === 'succeeded')
          .reduce((sum, c) => sum + c.amount, 0);
      } catch { /* ignore */ }
      return { ...acct, availableBalance, pendingBalance, recentVolume };
    };

    const enriched = await processBatch(accounts.data, 10, enrichAccount);

    // Sort: pending balance desc → recent volume desc → created desc
    enriched.sort((a, b) => {
      const balDiff = (b.availableBalance + b.pendingBalance) - (a.availableBalance + a.pendingBalance);
      if (balDiff !== 0) return balDiff;
      const volDiff = b.recentVolume - a.recentVolume;
      if (volDiff !== 0) return volDiff;
      return b.created - a.created;
    });

    return enriched;
  } catch {
    return [];
  }
}

function formatAccountChoice(acct) {
  const pkShort = acct.pk.length > 20
    ? `${acct.pk.slice(0, 12)}...${acct.pk.slice(-4)}`
    : acct.pk;
  const type = acct.isPlatform ? 'Platform' : 'Standard';
  return `${acct.name} (${pkShort}) — ${type}`;
}

async function selectOrCreateAccount(config) {
  // Build choices from saved accounts
  const choices = config.accounts.map(acct => ({
    name: formatAccountChoice(acct),
    value: acct.sk,
    _searchName: acct.name.toLowerCase(),
  }));
  const newOption = { name: '+ Enter new API keys', value: '__new__', _searchName: 'new enter add' };
  choices.push(newOption);

  let selectedSk;
  if (config.accounts.length > 0) {
    const { picked } = await inquirer.prompt([{
      type: 'autocomplete',
      name: 'picked',
      message: 'Select a Stripe account — type to filter',
      source: (_answersSoFar, input) => {
        const term = (input || '').toLowerCase();
        if (!term) return choices;
        return choices.filter(c => c._searchName.includes(term) || c.name.toLowerCase().includes(term));
      },
    }]);
    selectedSk = picked;
  } else {
    selectedSk = '__new__';
  }

  if (selectedSk === '__new__') {
    return await createNewAccount(config);
  }

  // Return existing account (will be refreshed in main)
  const account = config.accounts.find(a => a.sk === selectedSk);
  account.lastUsed = new Date().toISOString();
  saveAccountToConfig(config, account);
  return account;
}

async function createNewAccount(config) {
  console.log('');
  const { pk, sk } = await inquirer.prompt([
    { type: 'input', name: 'pk', message: 'Publishable Key (pk_test_...):' },
    { type: 'input', name: 'sk', message: 'Secret Key (sk_test_...):' },
  ]);

  console.log('\n→ Connecting to Stripe...');
  const stripe = new Stripe(sk, { apiVersion: '2023-10-16' });

  // Fetch account display name
  const detectedName = await fetchAccountName(stripe);

  // Detect platform + connected accounts
  const connectedRaw = await detectPlatform(stripe);
  const isPlatform = connectedRaw.length > 0;
  const connectedAccounts = connectedRaw.map(a => ({
    id: a.id,
    name: a.business_profile?.name
              || a.settings?.dashboard?.display_name
              || (a.individual ? `${a.individual.first_name || ''} ${a.individual.last_name || ''}`.trim() : null)
              || a.company?.name
              || a.email
              || 'Unnamed',
    businessType: a.business_type || null,
    balance: (a.availableBalance || 0) + (a.pendingBalance || 0),
    volume: a.recentVolume || 0,
  }));

  const defaultName = detectedName || 'My Stripe Account';
  const { name } = await inquirer.prompt([{
    type: 'input',
    name: 'name',
    message: 'Friendly name for this account?',
    default: defaultName,
  }]);

  const account = {
    name,
    pk,
    sk,
    isPlatform,
    connectedAccounts,
    lastConnectedAccountId: null,
    lastRunSettings: {},
    lastUsed: new Date().toISOString(),
  };

  saveAccountToConfig(config, account);
  console.log(`✓ Saved "${name}" ${isPlatform ? '(Platform)' : '(Standard)'}.\n`);
  return account;
}

// ---------------------------------------------------------------------------
// Connected account selector (scoped to current account)
// ---------------------------------------------------------------------------

function formatMoney(cents) {
  if (cents === 0) return '$0';
  return `$${(cents / 100).toLocaleString('en-AU', { minimumFractionDigits: 2 })}`;
}

async function selectConnectedAccount(account) {
  const backOption = { name: '← Back', value: '__back__', _searchName: 'back' };
  const platformDirect = {
    name: '  No connected account (platform direct)',
    value: null,
    _searchName: 'no connected account platform direct',
  };

  // Calculate column widths from data
  const cas = account.connectedAccounts;
  const nameWidth = Math.max(12, ...cas.map(ca => ca.name.length));
  const typeWidth = Math.max(4, ...cas.map(ca => (ca.businessType || '').length));
  const idWidth = Math.max(4, ...cas.map(ca => ca.id.length));

  const accountChoices = cas.map(ca => {
    const marker = ca.id === account.lastConnectedAccountId ? ' ◀' : '';
    const bal = ca.balance ? formatMoney(ca.balance) : '-';
    const vol = ca.volume ? formatMoney(ca.volume) : '-';
    const nameCol = ca.name.padEnd(nameWidth);
    const typeCol = (ca.businessType || '').padEnd(typeWidth);
    const idCol = ca.id.padEnd(idWidth);
    const balCol = bal.padStart(12);
    const volCol = vol.padStart(12);
    return {
      name: `${nameCol}  ${typeCol}  ${idCol}  Bal:${balCol}  Vol:${volCol}${marker}`,
      value: ca.id,
      _searchName: ca.name.toLowerCase(),
    };
  });
  const allChoices = [backOption, platformDirect, ...accountChoices];

  const { selected } = await inquirer.prompt([{
    type: 'autocomplete',
    name: 'selected',
    message: `Select connected account (${account.connectedAccounts.length} available) — type to filter`,
    source: (_answersSoFar, input) => {
      const term = (input || '').toLowerCase();
      if (!term) return allChoices;
      return allChoices.filter(c => c._searchName.includes(term) || (c.value && c.value.toLowerCase().includes(term)));
    },
    default: account.lastConnectedAccountId
      && account.connectedAccounts.some(ca => ca.id === account.lastConnectedAccountId)
      ? account.lastConnectedAccountId
      : null,
  }]);

  return selected;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomAmount(min = 500, max = 50000) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomPaymentMethod() {
  const paymentMethods = [
    'pm_card_visa',
    'pm_card_bypassPending',
    'pm_card_bypassPendingInternational',
    'pm_card_mastercard',
    'pm_card_amex',
  ];
  return paymentMethods[Math.floor(Math.random() * paymentMethods.length)];
}

function randomFailingPaymentMethod() {
  const failingPaymentMethods = [
    'pm_card_chargeDeclined',
    'pm_card_chargeDeclinedInsufficientFunds',
    'pm_card_chargeDeclinedLostCard',
    'pm_card_chargeDeclinedStolenCard',
    'pm_card_createDispute',
    'pm_card_pendingRefund',
    'pm_card_createIssuerFraudRecord',
    'pm_card_radarBlock',
    'pm_card_cvcCheckFail',
    'pm_card_cvcCheckFail',
  ];
  return failingPaymentMethods[Math.floor(Math.random() * failingPaymentMethods.length)];
}

function randomCustomerData() {
  const firstNames = ['Emma', 'Liam', 'Olivia', 'Noah', 'Ava', 'William', 'Sophia', 'James', 'Isabella', 'Oliver', 'Charlotte', 'Benjamin', 'Amelia', 'Lucas', 'Mia'];
  const lastNames = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Wilson', 'Anderson', 'Thomas'];
  const domains = ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com'];

  const firstName = firstNames[Math.floor(Math.random() * firstNames.length)];
  const lastName = lastNames[Math.floor(Math.random() * lastNames.length)];
  const domain = domains[Math.floor(Math.random() * domains.length)];
  const randomNum = Math.floor(Math.random() * 9999);

  return {
    name: `${firstName} ${lastName}`,
    email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}${randomNum}@${domain}`,
  };
}

// ---------------------------------------------------------------------------
// Batch processing
// ---------------------------------------------------------------------------

async function processBatch(items, batchSize, processFn) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(processFn));
    results.push(...batchResults);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Customer creation
// ---------------------------------------------------------------------------

async function createTestCustomers(stripe, count, connectedAccountId = null) {
  try {
    const accountInfo = connectedAccountId ? ` on ${connectedAccountId}` : '';
    console.log(`\n→ Creating ${count} test customer${count > 1 ? 's' : ''}${accountInfo} with default payment methods...\n`);

    const BATCH_SIZE = 10;
    let completed = 0;
    const customerIndices = Array.from({ length: count }, (_, i) => i + 1);

    const createCustomer = async (i) => {
      try {
        const customerData = randomCustomerData();
        const paymentMethod = randomPaymentMethod();
        const createOptions = connectedAccountId ? { stripeAccount: connectedAccountId } : {};
        const customer = await stripe.customers.create({
          name: customerData.name,
          email: customerData.email,
          description: `Test customer ${i} from seed-transactions app`,
          payment_method: paymentMethod,
          invoice_settings: { default_payment_method: paymentMethod },
        }, createOptions);

        completed++;
        console.log(`  [${completed}/${count}] ✓ ${customer.id} - ${customer.name} (${customer.email}) - PM: ${paymentMethod}`);
        return { success: true, customer };
      } catch (error) {
        completed++;
        console.log(`  [${completed}/${count}] ✗ Failed: ${error.message}`);
        return { success: false, error: error.message };
      }
    };

    const batchResults = await processBatch(customerIndices, BATCH_SIZE, createCustomer);
    const successfulCustomers = batchResults.filter(r => r.success).map(r => r.customer);
    const failed = batchResults.filter(r => !r.success).length;

    console.log('\n✓ Customer creation complete!');
    console.log(`  Succeeded: ${successfulCustomers.length}`);
    console.log(`  Failed: ${failed}`);
    console.log(`  Total: ${count}\n`);

    return successfulCustomers;
  } catch (error) {
    console.error('✗ Error creating customers:', error.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Payment creation
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Payment mix presets
// ---------------------------------------------------------------------------

const PAYMENT_PRESETS = {
  realistic:    { label: 'Realistic',     succeed: 85, pending: 10, fail: 5 },
  all_succeed:  { label: 'All succeed',   succeed: 100, pending: 0,  fail: 0 },
  high_failure: { label: 'High failure',  succeed: 70, pending: 10, fail: 20 },
  stress_test:  { label: 'Stress test',   succeed: 50, pending: 10, fail: 40 },
};

function describePreset(p) {
  const parts = [];
  if (p.succeed) parts.push(`${p.succeed}% succeed`);
  if (p.pending) parts.push(`${p.pending}% pending`);
  if (p.fail)    parts.push(`${p.fail}% fail`);
  return parts.join(', ');
}

function pickPaymentMethod(mix) {
  const roll = Math.random() * 100;
  if (roll < mix.succeed) {
    return 'pm_card_bypassPending';
  } else if (roll < mix.succeed + mix.pending) {
    return randomPaymentMethod();
  } else {
    return randomFailingPaymentMethod();
  }
}

// ---------------------------------------------------------------------------
// Payment creation
// ---------------------------------------------------------------------------

// chargeType: 'direct' | 'destination' | 'destination_obo' | null (platform-only)
async function createTestPayments(stripe, count, paymentMix, customers = [], connectedAccountId = null, chargeType = null, applicationFee = null) {
  try {
    const chargeLabel = chargeType ? ` [${chargeType}]` : '';
    const accountInfo = connectedAccountId ? ` → ${connectedAccountId}` : '';
    const mixLabel = describePreset(paymentMix);
    console.log(`\n→ Creating ${count} payment${count > 1 ? 's' : ''}${chargeLabel}${accountInfo} (${mixLabel})...\n`);

    const results = { succeeded: 0, failed: 0, total: count };
    const transactionIndices = Array.from({ length: count }, (_, i) => i + 1);
    const BATCH_SIZE = 10;
    let completed = 0;

    const createPaymentIntent = async (i) => {
      try {
        const amount = randomAmount();
        const paymentMethod = pickPaymentMethod(paymentMix);

        const paymentIntentParams = {
          amount,
          currency: 'aud',
          description: `Test transaction ${i} from seed-transactions app`,
          payment_method: paymentMethod,
          confirm: true,
          automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
        };

        // Link to a random customer if available
        if (customers.length > 0) {
          paymentIntentParams.customer = customers[Math.floor(Math.random() * customers.length)].id;
        }

        // Calculate application fee amount
        let feeAmount = null;
        if (applicationFee && connectedAccountId) {
          if (applicationFee.mode === 'percentage') {
            feeAmount = Math.round(amount * applicationFee.value / 100);
          } else {
            feeAmount = applicationFee.value;
          }
        }

        // Build request options based on charge type
        let createOptions = {};

        if (chargeType === 'direct') {
          // Direct charge: PI created on connected account via stripeAccount header
          createOptions = { stripeAccount: connectedAccountId };
          if (feeAmount) {
            paymentIntentParams.application_fee_amount = feeAmount;
          }
        } else if (chargeType === 'destination') {
          // Destination charge: PI on platform, funds transferred to connected account
          paymentIntentParams.transfer_data = { destination: connectedAccountId };
          if (feeAmount) {
            paymentIntentParams.application_fee_amount = feeAmount;
          }
        } else if (chargeType === 'destination_obo') {
          // Destination charge (on_behalf_of): PI on platform, settlement on connected account
          paymentIntentParams.transfer_data = { destination: connectedAccountId };
          paymentIntentParams.on_behalf_of = connectedAccountId;
          if (feeAmount) {
            paymentIntentParams.application_fee_amount = feeAmount;
          }
        }
        // else: no connected account — plain platform payment

        const paymentIntent = await stripe.paymentIntents.create(paymentIntentParams, createOptions);

        completed++;
        const customerInfo = paymentIntent.customer ? ` - Customer: ${paymentIntent.customer}` : '';
        console.log(`  [${completed}/${count}] ✓ ${paymentIntent.id} - $${(paymentIntent.amount / 100).toFixed(2)} - ${paymentMethod} - Status: ${paymentIntent.status}${customerInfo}`);
        return { success: true, index: i };
      } catch (error) {
        completed++;
        console.log(`  [${completed}/${count}] ✗ Failed: ${error.message}`);
        return { success: false, index: i, error: error.message };
      }
    };

    const batchResults = await processBatch(transactionIndices, BATCH_SIZE, createPaymentIntent);
    results.succeeded = batchResults.filter(r => r.success).length;
    results.failed = batchResults.filter(r => !r.success).length;

    console.log('\n✓ Transaction creation complete!');
    console.log(`  Succeeded: ${results.succeeded}`);
    console.log(`  Failed: ${results.failed}`);
    console.log(`  Total: ${results.total}\n`);
  } catch (error) {
    console.error('✗ Error creating transactions:', error.message);
  }
}

// ---------------------------------------------------------------------------
// CLI flag parsing
// ---------------------------------------------------------------------------

function parseFlags() {
  const args = process.argv.slice(2);
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') { flags.help = true; continue; }
    if (arg === '--last') { flags.last = true; continue; }
    if (arg === '--account' && args[i + 1]) { flags.account = args[++i]; continue; }
    if (arg === '--connected' && args[i + 1]) { flags.connected = args[++i]; continue; }
    if (arg === '--charge-type' && args[i + 1]) { flags.chargeType = args[++i]; continue; }
    if (arg === '--payments' && args[i + 1]) { flags.payments = parseInt(args[++i], 10); continue; }
    if (arg === '--customers' && args[i + 1]) { flags.customers = parseInt(args[++i], 10); continue; }
    if (arg === '--link-customers') { flags.linkCustomers = true; continue; }
    if (arg === '--preset' && args[i + 1]) { flags.preset = args[++i]; continue; }
    if (arg === '--fee-cents' && args[i + 1]) { flags.feeCents = parseInt(args[++i], 10); continue; }
    if (arg === '--fee-pct' && args[i + 1]) { flags.feePct = parseFloat(args[++i]); continue; }
  }
  return flags;
}

function printHelp() {
  console.log(`
Usage: node index.js [options]

No options → interactive mode (arrow-key menus)

Options:
  --help, -h            Show this help message
  --account <name>      Saved account name (fuzzy match)
  --last                Replay last run settings for the matched account
  --connected <id>      Connected account ID (acct_...)
  --charge-type <type>  direct | destination | destination_obo
  --payments <n>        Number of payments to create
  --customers <n>       Seed this many customers before payments
  --link-customers      Link payments to customers
  --preset <name>       Payment mix: realistic | all_succeed | high_failure | stress_test
  --fee-cents <n>       Fixed application fee in cents
  --fee-pct <n>         Application fee as percentage

Examples:
  # Replay last settings for "Synergy Emporium"
  node index.js --account Synergy --last

  # 50 payments on a connected account with 10% fee
  node index.js --account Synergy --connected acct_1Seng... --charge-type direct \\
    --payments 50 --preset realistic --fee-pct 10

  # Seed 20 customers + 100 payments, all succeed
  node index.js --account Synergy --customers 20 --link-customers \\
    --payments 100 --preset all_succeed
`);
}

async function runCli(flags) {
  const config = loadConfig();

  // Find account by fuzzy name match
  const match = config.accounts.find(a =>
    a.name.toLowerCase().includes(flags.account.toLowerCase())
  );
  if (!match) {
    console.error(`✗ No saved account matching "${flags.account}". Saved accounts:`);
    config.accounts.forEach(a => console.error(`  - ${a.name}`));
    process.exit(1);
  }

  const stripe = new Stripe(match.sk, { apiVersion: '2023-10-16' });
  console.log(`✓ Using account: ${match.name}`);

  // Resolve settings: flags override last-run, which overrides defaults
  const saved = flags.last ? (match.lastRunSettings || {}) : {};

  const connectedAccountId = flags.connected || (flags.last ? match.lastConnectedAccountId : null);
  const chargeType = flags.chargeType || saved.chargeType || null;
  const paymentCount = flags.payments || saved.transactionCount || 10;
  const customerCount = flags.customers ?? (flags.last && saved.seedCustomers ? (saved.customerCount || 0) : 0);
  const linkCustomers = flags.linkCustomers ?? saved.linkPaymentsToCustomers ?? false;

  // Payment mix
  const presetKey = flags.preset || saved.paymentPreset || 'realistic';
  const paymentMix = PAYMENT_PRESETS[presetKey]
    || (presetKey === 'custom' && saved.customMix)
    || PAYMENT_PRESETS.realistic;

  // Application fee
  let applicationFee = null;
  if (flags.feePct) {
    applicationFee = { mode: 'percentage', value: flags.feePct };
  } else if (flags.feeCents) {
    applicationFee = { mode: 'cents', value: flags.feeCents };
  } else if (flags.last && saved.applicationFee && saved.applicationFee.value > 0) {
    applicationFee = saved.applicationFee;
  }

  // Determine customer scope
  const customersOnConnected = chargeType === 'direct';
  const customerStripeAccount = customersOnConnected ? connectedAccountId : null;

  // Summary
  console.log('\n┌─────────────────────────────────────────');
  console.log('│  Seed Payments (CLI mode)');
  console.log('├─────────────────────────────────────────');
  if (connectedAccountId) {
    const caName = match.connectedAccounts?.find(c => c.id === connectedAccountId)?.name || '';
    console.log(`│  Account:       ${caName} (${connectedAccountId})`);
    console.log(`│  Charge type:   ${chargeType || 'direct'}`);
  } else {
    console.log(`│  Account:       ${match.name} (platform direct)`);
  }
  if (customerCount > 0) console.log(`│  Seed cust:     ${customerCount}`);
  console.log(`│  Link to cust:  ${linkCustomers ? 'Yes' : 'No'}`);
  console.log(`│  Payments:      ${paymentCount}`);
  console.log(`│  Payment mix:   ${describePreset(paymentMix)}`);
  if (applicationFee) {
    const feeLabel = applicationFee.mode === 'percentage'
      ? `${applicationFee.value}% of each payment`
      : `${applicationFee.value}¢ per payment`;
    console.log(`│  App fee:       ${feeLabel}`);
  }
  console.log('└─────────────────────────────────────────\n');

  // Seed customers
  let customers = [];
  if (customerCount > 0) {
    customers = await createTestCustomers(stripe, customerCount, customerStripeAccount);
  }

  // Fetch existing customers if linking but none seeded
  if (linkCustomers && customers.length === 0) {
    console.log('→ Fetching existing customers...');
    try {
      const listOptions = customerStripeAccount ? { stripeAccount: customerStripeAccount } : {};
      const existing = await stripe.customers.list({ limit: 100 }, listOptions);
      customers = existing.data;
      console.log(`✓ Found ${customers.length} existing customers.\n`);
    } catch (error) {
      console.error('✗ Error fetching customers:', error.message);
    }
  }

  const customersToLink = linkCustomers ? customers : [];
  await createTestPayments(stripe, paymentCount, paymentMix, customersToLink, connectedAccountId, chargeType || (connectedAccountId ? 'direct' : null), applicationFee);

  // Save as last-run settings
  match.lastRunSettings = {
    ...saved,
    transactionCount: paymentCount,
    seedCustomers: customerCount > 0,
    customerCount,
    linkPaymentsToCustomers: linkCustomers,
    paymentPreset: presetKey,
    chargeType,
    applicationFee: applicationFee || { mode: 'cents', value: 0 },
  };
  if (connectedAccountId) match.lastConnectedAccountId = connectedAccountId;
  match.lastUsed = new Date().toISOString();
  saveAccountToConfig(config, match);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const flags = parseFlags();

  if (flags.help) {
    printHelp();
    return;
  }

  // CLI mode: if --account is provided, run non-interactively
  if (flags.account) {
    await runCli(flags);
    return;
  }

  // Interactive mode
  try {
    const config = loadConfig();

    // Account selection loop (re-entered on "Switch account")
    let account = await selectOrCreateAccount(config);

    while (true) {
      // Init Stripe client for the selected account
      const stripe = new Stripe(account.sk, { apiVersion: '2023-10-16' });
      const cachedCount = account.connectedAccounts?.length || 0;
      const type = account.isPlatform ? 'Platform' : 'Standard';
      console.log(`\n✓ Connected as "${account.name}" (${type}${account.isPlatform ? `, ${cachedCount} cached connected accounts` : ''}).`);

      // Menu loop
      let stayInMenu = true;
      while (stayInMenu) {
        const menuChoices = [
          { name: 'Create test payments', value: 'create' },
        ];
        if (account.isPlatform) {
          menuChoices.push({ name: `Refresh connected accounts (${cachedCount} cached)`, value: 'refresh' });
        }
        menuChoices.push(
          { name: 'Switch account', value: 'switch' },
          { name: 'Remove a saved account', value: 'remove' },
          { name: 'Exit', value: 'exit' },
        );

        const { action } = await inquirer.prompt([{
          type: 'list',
          name: 'action',
          message: 'What would you like to do?',
          choices: menuChoices,
        }]);

        switch (action) {
          // -----------------------------------------------------------
          case 'create': {
            const savedSettings = account.lastRunSettings || {};

            // Connected account + charge type selection (platforms only)
            let connectedAccountId = null;
            let chargeType = null;
            if (account.isPlatform) {
              connectedAccountId = await selectConnectedAccount(account);
              if (connectedAccountId === '__back__') break;
              if (connectedAccountId) {
                account.lastConnectedAccountId = connectedAccountId;
                console.log(`\n  → Using connected account: ${connectedAccountId}`);

                // Choose charge type
                const { chargeTypeChoice } = await inquirer.prompt([{
                  type: 'list', name: 'chargeTypeChoice',
                  message: 'Charge type',
                  choices: [
                    { name: '← Back', value: '__back__' },
                    { name: 'Direct — charge created on connected account', value: 'direct' },
                    { name: 'Destination — charge on platform, funds transferred', value: 'destination' },
                    { name: 'Destination (on_behalf_of) — settlement on connected account', value: 'destination_obo' },
                  ],
                  default: savedSettings.chargeType || 'direct',
                }]);
                if (chargeTypeChoice === '__back__') break;
                chargeType = chargeTypeChoice;
                savedSettings.chargeType = chargeType;
              } else {
                console.log('\n  → Creating payments directly on the platform.');
              }
            }

            // Determine where customers live based on charge type
            // Direct: customers on the connected account (stripeAccount header)
            // Destination / OBO: customers on the platform
            const customersOnConnected = chargeType === 'direct';
            const customerStripeAccount = customersOnConnected ? connectedAccountId : null;

            // Seed customers
            let customers = [];
            let linkPaymentsToCustomers = false;

            const seedCustomers = await yesNo('Seed customers?', savedSettings.seedCustomers ?? false);

            if (seedCustomers) {
              const { customerCountStr } = await inquirer.prompt([{
                type: 'input', name: 'customerCountStr',
                message: 'How many customers?',
                default: String(savedSettings.customerCount || 10),
              }]);
              const customerCount = parseInt(customerCountStr, 10);
              if (isNaN(customerCount) || customerCount < 1) {
                console.log('✗ Invalid number. Skipping customer creation.\n');
              } else {
                customers = await createTestCustomers(stripe, customerCount, customerStripeAccount);
                savedSettings.customerCount = customerCount;
              }
            }
            savedSettings.seedCustomers = seedCustomers;

            // Link payments to customers
            linkPaymentsToCustomers = await yesNo('Link payments to customers?', savedSettings.linkPaymentsToCustomers ?? false);

            if (linkPaymentsToCustomers && customers.length === 0) {
              const accountLabel = customerStripeAccount ? ` from ${customerStripeAccount}` : '';
              console.log(`\n→ Fetching existing customers${accountLabel}...`);
              try {
                const listOptions = customerStripeAccount ? { stripeAccount: customerStripeAccount } : {};
                const existingCustomers = await stripe.customers.list({ limit: 100 }, listOptions);
                customers = existingCustomers.data;
                console.log(`✓ Found ${customers.length} existing customer${customers.length !== 1 ? 's' : ''}.\n`);
                if (customers.length === 0) {
                  console.log('✗ No existing customers found. Payments will not be linked.\n');
                  linkPaymentsToCustomers = false;
                }
              } catch (error) {
                console.error('✗ Error fetching customers:', error.message);
                linkPaymentsToCustomers = false;
              }
            }
            savedSettings.linkPaymentsToCustomers = linkPaymentsToCustomers;

            // Transaction count
            const { transactionCountStr } = await inquirer.prompt([{
              type: 'input', name: 'transactionCountStr',
              message: 'How many transactions?',
              default: String(savedSettings.transactionCount || 10),
            }]);
            const transactionCount = parseInt(transactionCountStr, 10);
            if (isNaN(transactionCount) || transactionCount < 1) {
              console.log('✗ Invalid number.\n');
              break;
            }
            savedSettings.transactionCount = transactionCount;

            // Payment mix
            const presetChoices = Object.entries(PAYMENT_PRESETS).map(([key, p]) => ({
              name: `${p.label.padEnd(14)} — ${describePreset(p)}`,
              value: key,
            }));
            presetChoices.push({ name: 'Custom         — configure percentages manually', value: 'custom' });

            const { presetKey } = await inquirer.prompt([{
              type: 'list', name: 'presetKey',
              message: 'Payment mix',
              choices: presetChoices,
              default: savedSettings.paymentPreset || 'realistic',
            }]);

            let paymentMix;
            if (presetKey === 'custom') {
              const { succeedStr } = await inquirer.prompt([{
                type: 'input', name: 'succeedStr',
                message: 'Succeed instantly %',
                default: String(savedSettings.customMix?.succeed ?? 70),
              }]);
              const { pendingStr } = await inquirer.prompt([{
                type: 'input', name: 'pendingStr',
                message: 'Pending then succeed %',
                default: String(savedSettings.customMix?.pending ?? 20),
              }]);
              const { failStr } = await inquirer.prompt([{
                type: 'input', name: 'failStr',
                message: 'Fail %',
                default: String(savedSettings.customMix?.fail ?? 10),
              }]);
              const succeed = parseFloat(succeedStr) || 0;
              const pending = parseFloat(pendingStr) || 0;
              const fail = parseFloat(failStr) || 0;
              const total = succeed + pending + fail;
              if (total <= 0) {
                console.log('✗ Invalid mix. Using Realistic preset.\n');
                paymentMix = { ...PAYMENT_PRESETS.realistic };
              } else {
                // Normalise to 100%
                paymentMix = {
                  succeed: Math.round(succeed / total * 100),
                  pending: Math.round(pending / total * 100),
                  fail: Math.round(fail / total * 100),
                };
              }
              savedSettings.customMix = paymentMix;
            } else {
              paymentMix = { ...PAYMENT_PRESETS[presetKey] };
            }
            savedSettings.paymentPreset = presetKey;
            console.log(`  → ${describePreset(paymentMix)}`);

            // Application fee (connected accounts only)
            let applicationFee = null;
            if (connectedAccountId) {
              const savedFee = savedSettings.applicationFee || { mode: 'cents', value: 0 };

              const { feeMode } = await inquirer.prompt([{
                type: 'list', name: 'feeMode',
                message: 'Application fee type',
                choices: [
                  { name: 'Fixed amount (cents)', value: 'cents' },
                  { name: 'Percentage of payment', value: 'percentage' },
                  { name: 'No fee', value: 'none' },
                ],
                default: savedFee.value === 0 ? 'none' : savedFee.mode,
              }]);

              if (feeMode !== 'none') {
                const label = feeMode === 'cents' ? 'Fee in cents' : 'Fee percentage';
                const { feeVal } = await inquirer.prompt([{
                  type: 'input', name: 'feeVal',
                  message: label,
                  default: String(savedFee.mode === feeMode ? savedFee.value : (feeMode === 'cents' ? 100 : 10)),
                }]);
                const parsed = parseFloat(feeVal);
                if (isNaN(parsed) || parsed <= 0 || (feeMode === 'percentage' && parsed > 100)) {
                  console.log('✗ Invalid value. Using no fee.\n');
                } else {
                  applicationFee = { mode: feeMode, value: feeMode === 'cents' ? Math.round(parsed) : parsed };
                }
              }
              savedSettings.applicationFee = applicationFee || { mode: 'cents', value: 0 };
            }

            // Persist settings on this account
            account.lastRunSettings = savedSettings;
            saveAccountToConfig(config, account);

            // Confirmation summary
            const customersToLink = linkPaymentsToCustomers ? customers : [];
            console.log('\n┌─────────────────────────────────────────');
            console.log('│  Ready to seed');
            console.log('├─────────────────────────────────────────');
            if (connectedAccountId) {
              const caName = account.connectedAccounts.find(c => c.id === connectedAccountId)?.name || '';
              console.log(`│  Account:       ${caName} (${connectedAccountId})`);
              console.log(`│  Charge type:   ${chargeType}`);
            } else {
              console.log(`│  Account:       ${account.name} (platform direct)`);
            }
            if (customers.length > 0) {
              console.log(`│  Customers:     ${customers.length} seeded`);
            }
            console.log(`│  Link to cust:  ${linkPaymentsToCustomers ? `Yes (${customersToLink.length} available)` : 'No'}`);
            console.log(`│  Payments:      ${transactionCount}`);
            console.log(`│  Payment mix:   ${describePreset(paymentMix)}`);
            if (applicationFee) {
              const feeLabel = applicationFee.mode === 'percentage'
                ? `${applicationFee.value}% of each payment`
                : `${applicationFee.value}¢ per payment`;
              console.log(`│  App fee:       ${feeLabel}`);
            }
            console.log('└─────────────────────────────────────────\n');

            const proceed = await yesNo('Proceed?', true);
            if (!proceed) {
              console.log('Cancelled.\n');
              break;
            }

            // Execute
            await createTestPayments(stripe, transactionCount, paymentMix, customersToLink, connectedAccountId, chargeType, applicationFee);
            break;
          }

          // -----------------------------------------------------------
          case 'refresh': {
            console.log('\n→ Refreshing connected accounts from Stripe...');
            const connectedRaw = await detectPlatform(stripe);
            account.isPlatform = connectedRaw.length > 0;
            account.connectedAccounts = connectedRaw.map(a => ({
              id: a.id,
              name: a.business_profile?.name
              || a.settings?.dashboard?.display_name
              || (a.individual ? `${a.individual.first_name || ''} ${a.individual.last_name || ''}`.trim() : null)
              || a.company?.name
              || a.email
              || 'Unnamed',
              businessType: a.business_type || null,
              balance: (a.availableBalance || 0) + (a.pendingBalance || 0),
              volume: a.recentVolume || 0,
            }));
            saveAccountToConfig(config, account);
            console.log(`✓ Found ${account.connectedAccounts.length} connected account${account.connectedAccounts.length !== 1 ? 's' : ''}.\n`);
            stayInMenu = false; // re-enter to update menu label with new count
            break;
          }

          // -----------------------------------------------------------
          case 'switch':
            account = await selectOrCreateAccount(config);
            stayInMenu = false; // break inner menu to re-init stripe
            break;

          // -----------------------------------------------------------
          case 'remove': {
            if (config.accounts.length === 0) {
              console.log('No saved accounts to remove.\n');
              break;
            }
            const removeChoices = config.accounts.map(a => ({
              name: formatAccountChoice(a),
              value: a.sk,
            }));
            removeChoices.push({ name: 'Cancel', value: '__cancel__' });

            const { toRemove } = await inquirer.prompt([{
              type: 'list', name: 'toRemove',
              message: 'Which account to remove?',
              choices: removeChoices,
            }]);

            if (toRemove !== '__cancel__') {
              const removed = config.accounts.find(a => a.sk === toRemove);
              config.accounts = config.accounts.filter(a => a.sk !== toRemove);
              saveConfig(config);
              console.log(`✓ Removed "${removed.name}".\n`);

              // If we just removed the active account, re-select
              if (toRemove === account.sk) {
                if (config.accounts.length === 0) {
                  console.log('No accounts left. Please add new keys.\n');
                }
                account = await selectOrCreateAccount(config);
                stayInMenu = false;
              }
            }
            break;
          }

          // -----------------------------------------------------------
          case 'exit':
            console.log('Goodbye!\n');
            return;
        }
      }
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main().catch(console.error);

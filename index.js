#!/usr/bin/env node

import Stripe from 'stripe';
import fs from 'fs';
import readline from 'readline';
import { promisify } from 'util';

const CONFIG_FILE = './config.json';

console.log('=================================');
console.log('  Seed Payments Application  ');
console.log('=================================\n');

// Create readline interface
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const question = promisify(rl.question).bind(rl);

// Load configuration
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Error loading config:', error.message);
  }
  return null;
}

// Save configuration
function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    console.log('✓ Configuration saved.\n');
  } catch (error) {
    console.error('Error saving config:', error.message);
  }
}

// Get or prompt for API keys
async function getApiKeys() {
  let config = loadConfig();
  
  if (config && config.pk && config.sk) {
    console.log('✓ Found saved API keys:');
    console.log(`  PK: ${config.pk}`);
    console.log(`  SK: ${config.sk.slice(0, 12)}...${config.sk.slice(-4)}`);
    const useExisting = await question('Use existing keys? (y/n): ');
    if (useExisting.toLowerCase() === 'y') {
      return config;
    }
  }
  
  console.log('\nPlease enter your Stripe API keys:');
  const pk = await question('Publishable Key (pk_test_...): ');
  const sk = await question('Secret Key (sk_test_...): ');
  
  config = { pk, sk };
  saveConfig(config);
  
  return config;
}

// Simple menu function
function displayMenu() {
  console.log('\nAvailable commands:');
  console.log('  1. Create test payments');
  console.log('  2. Reset API keys');
  console.log('  3. Exit\n');
}

// Generate random amount between min and max
function randomAmount(min = 500, max = 50000) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Randomly select a test payment method
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

// Randomly select a test payment method that will fail
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

// Generate random customer data
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

// Create test customers
async function createTestCustomers(stripe, count, connectedAccountId = null) {
  try {
    const accountInfo = connectedAccountId ? ` on ${connectedAccountId}` : '';
    console.log(`\n→ Creating ${count} test customer${count > 1 ? 's' : ''}${accountInfo} with default payment methods...\n`);
    
    const customers = [];
    const BATCH_SIZE = 10;
    let completed = 0;
    
    // Create array of customer indices
    const customerIndices = Array.from({ length: count }, (_, i) => i + 1);
    
    const createCustomer = async (i) => {
      try {
        const customerData = randomCustomerData();
        const paymentMethod = randomPaymentMethod();
        
        // Create customer (with optional connected account)
        const createOptions = connectedAccountId ? { stripeAccount: connectedAccountId } : {};
        const customer = await stripe.customers.create({
          name: customerData.name,
          email: customerData.email,
          description: `Test customer ${i} from seed-transactions app`,
          payment_method: paymentMethod,
          invoice_settings: {
            default_payment_method: paymentMethod,
          },
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
    
    // Extract successful customers
    const successfulCustomers = batchResults
      .filter(r => r.success)
      .map(r => r.customer);
    
    const succeeded = successfulCustomers.length;
    const failed = batchResults.filter(r => !r.success).length;
    
    console.log('\n✓ Customer creation complete!');
    console.log(`  Succeeded: ${succeeded}`);
    console.log(`  Failed: ${failed}`);
    console.log(`  Total: ${count}\n`);
    
    return successfulCustomers;
  } catch (error) {
    console.error('✗ Error creating customers:', error.message);
    return [];
  }
}

// Process items in batches with concurrency control
async function processBatch(items, batchSize, processFn) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(processFn));
    results.push(...batchResults);
  }
  return results;
}

// Create multiple test payment intents
async function createTestPayments(stripe, count, failurePercentage = 5, customers = [], alwaysBypassPending = false, connectedAccountId = null, applicationFeeAmount = null) {
  try {
    const accountInfo = connectedAccountId ? ` on ${connectedAccountId}` : '';
    console.log(`\n→ Creating ${count} test payment intent${count > 1 ? 's' : ''}${accountInfo} (${failurePercentage}% failure rate)...\n`);
    
    const results = {
      succeeded: 0,
      failed: 0,
      total: count
    };
    
    // Create array of transaction indices
    const transactionIndices = Array.from({ length: count }, (_, i) => i + 1);
    
    // Process with concurrency limit (10 concurrent requests)
    const BATCH_SIZE = 10;
    let completed = 0;
    
    const createPaymentIntent = async (i) => {
      try {
        const amount = randomAmount();
        // Determine payment method
        let paymentMethod;
        if (alwaysBypassPending) {
          // Always use bypass pending payment method
          paymentMethod = 'pm_card_bypassPending';
        } else {
          // Determine if this payment should fail based on the failure percentage
          const shouldFail = Math.random() * 100 < failurePercentage;
          paymentMethod = shouldFail ? randomFailingPaymentMethod() : randomPaymentMethod();
        }
        
        // Build payment intent parameters
        const paymentIntentParams = {
          amount: amount,
          currency: 'usd',
          description: `Test transaction ${i} from seed-transactions app`,
          payment_method: paymentMethod,
          confirm: true,
          automatic_payment_methods: {
            enabled: true,
            allow_redirects: 'never'
          },
        };
        
        // Randomly link to a customer if customers are provided
        if (customers.length > 0) {
          const randomCustomer = customers[Math.floor(Math.random() * customers.length)];
          paymentIntentParams.customer = randomCustomer.id;
        }
        
        // Add application fee if provided (for connected accounts)
        if (applicationFeeAmount && connectedAccountId) {
          paymentIntentParams.application_fee_amount = applicationFeeAmount;
        }
        
        // Create payment intent (with optional connected account for direct charges)
        const createOptions = connectedAccountId ? { stripeAccount: connectedAccountId } : {};
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
    
    // Count successes and failures
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

// Main execution
async function main() {
  try {
    // Get API keys
    const config = await getApiKeys();
    
    // Initialize Stripe with secret key
    const stripe = new Stripe(config.sk, {
      apiVersion: '2023-10-16',
    });
    
    console.log('\n✓ Stripe client initialized.\n');
    
    // Interactive menu loop
    let running = true;
    while (running) {
      displayMenu();
      const choice = await question('Select an option (1-3): ');
      
      switch (choice) {
        case '1':
          // Load saved settings
          let currentConfig = loadConfig() || {};
          const savedSettings = currentConfig.lastRunSettings || {};
          
          // Ask for connected account ID first (needed for customer fetching)
          let connectedAccountId = null;
          const useConnectedDefault = savedSettings.useConnectedAccount ? 'y' : 'n';
          const useConnectedInput = await question(`Use a connected account? (y/N) [${useConnectedDefault}]: `);
          const useConnectedAccount = useConnectedInput.trim() === '' ? savedSettings.useConnectedAccount : useConnectedInput.toLowerCase() === 'y';
          savedSettings.useConnectedAccount = useConnectedAccount;
          
          if (useConnectedAccount) {
            // Check if we have a saved connected account ID
            if (currentConfig.connectedAccountId) {
              console.log(`  Saved connected account: ${currentConfig.connectedAccountId}`);
              const useSavedDefault = 'y';
              const useSavedInput = await question(`Use saved connected account? (y/n) [${useSavedDefault}]: `);
              if (useSavedInput.trim() === '' || useSavedInput.toLowerCase() === 'y') {
                connectedAccountId = currentConfig.connectedAccountId;
              }
            }
            
            // If not using saved, prompt for new one
            if (!connectedAccountId) {
              const accountIdInput = await question('Connected Account ID (acct_...): ');
              if (accountIdInput.trim()) {
                connectedAccountId = accountIdInput.trim();
                currentConfig.connectedAccountId = connectedAccountId;
              }
            }
          }
          
          // Ask if user wants to seed customers
          let customers = [];
          let linkPaymentsToCustomers = false;
          
          const seedCustomersDefault = savedSettings.seedCustomers ? 'y' : 'n';
          const seedCustomersInput = await question(`Do you want to seed customers? (y/n) [${seedCustomersDefault}]: `);
          const seedCustomers = seedCustomersInput.trim() === '' ? savedSettings.seedCustomers : seedCustomersInput.toLowerCase() === 'y';
          
          if (seedCustomers) {
            const customerCountDefault = savedSettings.customerCount || 10;
            const customerCountInput = await question(`How many customers? [${customerCountDefault}]: `);
            const customerCount = customerCountInput.trim() === '' ? customerCountDefault : parseInt(customerCountInput, 10);
            
            if (isNaN(customerCount) || customerCount < 1) {
              console.log('✗ Invalid number. Skipping customer creation.\n');
            } else {
              customers = await createTestCustomers(stripe, customerCount, connectedAccountId);
              savedSettings.customerCount = customerCount;
            }
          }
          savedSettings.seedCustomers = seedCustomers;
          
          // Ask if payments should be linked to customers
          const linkDefault = savedSettings.linkPaymentsToCustomers ? 'y' : 'n';
          const linkInput = await question(`Link payments to customers? (y/n) [${linkDefault}]: `);
          linkPaymentsToCustomers = linkInput.trim() === '' ? savedSettings.linkPaymentsToCustomers : linkInput.toLowerCase() === 'y';
          
          // If linking but no customers seeded, fetch existing customers
          if (linkPaymentsToCustomers && customers.length === 0) {
            const accountLabel = connectedAccountId ? ` from ${connectedAccountId}` : '';
            console.log(`\n→ Fetching existing customers${accountLabel}...`);
            try {
              const listOptions = connectedAccountId ? { stripeAccount: connectedAccountId } : {};
              const existingCustomers = await stripe.customers.list({ limit: 100 }, listOptions);
              customers = existingCustomers.data;
              console.log(`✓ Found ${customers.length} existing customer${customers.length !== 1 ? 's' : ''}.\n`);
              if (customers.length === 0) {
                console.log('✗ No existing customers found. Payments will not be linked to customers.\n');
                linkPaymentsToCustomers = false;
              }
            } catch (error) {
              console.error('✗ Error fetching customers:', error.message);
              linkPaymentsToCustomers = false;
            }
          }
          savedSettings.linkPaymentsToCustomers = linkPaymentsToCustomers;
          
          // Ask how many transactions to create
          const transactionCountDefault = savedSettings.transactionCount || 10;
          const countInput = await question(`How many transactions would you like to create? [${transactionCountDefault}]: `);
          const transactionCount = countInput.trim() === '' ? transactionCountDefault : parseInt(countInput, 10);
          
          if (isNaN(transactionCount) || transactionCount < 1) {
            console.log('✗ Invalid number. Please enter a positive number.\n');
            break;
          }
          savedSettings.transactionCount = transactionCount;
          
          // Ask if should always bypass pending
          const bypassDefault = savedSettings.alwaysBypassPending ? 'y' : 'n';
          const bypassPendingInput = await question(`Always bypass pending? (y/N) [${bypassDefault}]: `);
          const alwaysBypassPending = bypassPendingInput.trim() === '' ? savedSettings.alwaysBypassPending : bypassPendingInput.toLowerCase() === 'y';
          savedSettings.alwaysBypassPending = alwaysBypassPending;
          
          // Ask for failure percentage
          let failurePercentage = savedSettings.failurePercentage || 5;
          const failureInput = await question(`What percentage of payments should fail? [${failurePercentage}%]: `);
          if (failureInput.trim() !== '') {
            failurePercentage = parseFloat(failureInput);
            if (isNaN(failurePercentage) || failurePercentage < 0 || failurePercentage > 100) {
              console.log('✗ Invalid percentage. Using default of 5%.\n');
              failurePercentage = 5;
            }
          }
          savedSettings.failurePercentage = failurePercentage;
          
          // Ask for application fee amount (only for connected accounts)
          let applicationFeeAmount = null;
          if (connectedAccountId) {
            const feeDefault = savedSettings.applicationFeeAmount || 0;
            const feeInput = await question(`Application fee amount in cents (0 for no fee) [${feeDefault}]: `);
            if (feeInput.trim() !== '') {
              applicationFeeAmount = parseInt(feeInput, 10);
              if (isNaN(applicationFeeAmount) || applicationFeeAmount < 0) {
                console.log('✗ Invalid amount. Using no fee.\n');
                applicationFeeAmount = null;
              } else if (applicationFeeAmount === 0) {
                applicationFeeAmount = null;
              }
            } else if (feeDefault > 0) {
              applicationFeeAmount = feeDefault;
            }
            savedSettings.applicationFeeAmount = applicationFeeAmount || 0;
          }
          
          // Save all settings
          currentConfig.lastRunSettings = savedSettings;
          saveConfig(currentConfig);
          
          // Create the transactions (with or without customer linking)
          const customersToLink = linkPaymentsToCustomers ? customers : [];
          await createTestPayments(stripe, transactionCount, failurePercentage, customersToLink, alwaysBypassPending, connectedAccountId, applicationFeeAmount);
          break;
          
        case '2':
          if (fs.existsSync(CONFIG_FILE)) {
            fs.unlinkSync(CONFIG_FILE);
            console.log('✓ API keys cleared. Please restart the application.\n');
          }
          running = false;
          break;
          
        case '3':
          console.log('Goodbye!\n');
          running = false;
          break;
          
        default:
          console.log('Invalid option. Please try again.\n');
      }
    }
    
    rl.close();
  } catch (error) {
    console.error('Error:', error.message);
    rl.close();
    process.exit(1);
  }
}

main().catch(console.error);

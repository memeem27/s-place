/**
 * Production-Ready Firebase Cloud Variable System for TurboWarp/Scratch
 * Features: Auto-integration, retry logic, offline queue, rate limiting, proper VM sync
 * 
 * IMPORTANT: Stores values as STRINGS to prevent scientific notation for large numbers
 */

class FirebaseCloudSystem {
  constructor(firebaseConfig, projectId, options = {}) {
    this.projectId = projectId;
    this.firebaseConfig = firebaseConfig;
    this.database = null;
    this.cloudVariables = new Map();
    this.connected = false;
    this.projectRef = null;
    this.vm = null;
    this.lastValues = new Map(); // Track last synced values
    
    // Configuration
    this.config = {
      maxRetries: options.maxRetries || 3,
      retryDelay: options.retryDelay || 1000,
      rateLimit: options.rateLimit || 10, // Max updates per second
      debug: options.debug || false,
      pollInterval: options.pollInterval || 500, // Poll every 500ms for changes
      ...options
    };
    
    // State management
    this.writeQueue = [];
    this.isProcessingQueue = false;
    this.rateLimitWindow = [];
    this.lastSync = Date.now();
    this.retryAttempts = new Map();
    this.debounceTimers = new Map();
    this.pollingInterval = null;
  }

  log(message, type = 'info') {
    const colors = {
      info: '\x1b[36m',    // Cyan
      success: '\x1b[32m', // Green
      warning: '\x1b[33m', // Yellow
      error: '\x1b[31m',   // Red
      debug: '\x1b[90m'    // Gray
    };
    const reset = '\x1b[0m';
    const prefix = '[Firebase Cloud]';
    
    if (type === 'debug' && !this.config.debug) return;
    
    console.log(`${colors[type]}${prefix} ${message}${reset}`);
  }

  async initialize() {
    try {
      // Check if Firebase SDK is loaded
      if (typeof firebase === 'undefined') {
        throw new Error(
          'Firebase SDK not loaded. Add these scripts before firebase-cloud-provider.js:\n' +
          '<script src="https://www.gstatic.com/firebasejs/9.22.0/firebase-app-compat.js"></script>\n' +
          '<script src="https://www.gstatic.com/firebasejs/9.22.0/firebase-database-compat.js"></script>'
        );
      }

      // Check for required Firebase methods
      if (!firebase.initializeApp || !firebase.database) {
        throw new Error('Firebase SDK incomplete. Make sure both app and database modules are loaded.');
      }
      
      // Find Scaffolding VM
      this.vm = await this.findScaffoldingVM();
      if (!this.vm) {
        throw new Error('Could not find Scaffolding VM. Make sure the project is loaded.');
      }
      
      this.log('Found Scaffolding VM', 'success');
      
      // Initialize Firebase (reuse existing app if already initialized)
      let app;
      try {
        app = firebase.app();
        this.log('Using existing Firebase app', 'info');
      } catch (e) {
        app = firebase.initializeApp(this.firebaseConfig);
        this.log('Initialized new Firebase app', 'success');
      }
      
      this.database = firebase.database(app);
      this.projectRef = this.database.ref(`projects/${this.sanitizeProjectId(this.projectId)}/variables`);
      
      this.log('Firebase initialized', 'success');
      
      // Set up connection monitoring
      this.setupConnectionMonitoring();
      
      // Wait for initial connection
      await this.waitForConnection();
      
      // Discover and sync cloud variables
      await this.discoverCloudVariables();
      
      // Set up Firebase listeners
      this.setupFirebaseListeners();
      
      // Intercept VM cloud variable changes (multiple approaches)
      this.interceptVMCloudChanges();
      this.monitorCloudVariables();
      
      // Start queue processor
      this.startQueueProcessor();
      
      // Start polling for changes (safety net)
      this.startPolling();
      
      this.log('\u2713 Cloud system fully initialized', 'success');
      return true;
    } catch (error) {
      this.log(`Initialization failed: ${error.message}`, 'error');
      console.error(error);
      return false;
    }
  }

  async findScaffoldingVM() {
    // Check if VM already exists
    if (window.scaffolding?.vm) return window.scaffolding.vm;
    if (window.vm) return window.vm;
    
    // If Scaffolding module exists but not instantiated, wait for initialization
    if (window.Scaffolding && !window.scaffolding) {
      this.log('Scaffolding module detected, waiting for instantiation...', 'info');
    }
    
    // Wait for VM to be ready
    return new Promise((resolve) => {
      let attempts = 0;
      const maxAttempts = 100; // 10 seconds
      
      const check = setInterval(() => {
        if (window.scaffolding?.vm) {
          clearInterval(check);
          this.log('Found VM at window.scaffolding.vm', 'debug');
          resolve(window.scaffolding.vm);
        } else if (window.vm) {
          clearInterval(check);
          this.log('Found VM at window.vm', 'debug');
          resolve(window.vm);
        } else if (attempts++ > maxAttempts) {
          clearInterval(check);
          this.log('VM not found after waiting', 'error');
          resolve(null);
        }
      }, 100);
    });
  }

  setupConnectionMonitoring() {
    this.database.ref('.info/connected').on('value', (snapshot) => {
      const wasConnected = this.connected;
      this.connected = snapshot.val() === true;
      
      if (this.connected) {
        this.log('\u2713 Connected to Firebase', 'success');
        if (wasConnected === false) {
          // Reconnected - process offline queue
          this.processQueue();
        }
      } else {
        this.log('\u26a0 Disconnected from Firebase', 'warning');
      }
    });
  }

  async waitForConnection(timeout = 10000) {
    const start = Date.now();
    while (!this.connected && Date.now() - start < timeout) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!this.connected) {
      throw new Error('Firebase connection timeout');
    }
  }

  async discoverCloudVariables() {
    // Get cloud variables from the VM runtime
    const stage = this.vm.runtime.getTargetForStage();
    if (!stage) {
      this.log('Stage not found, skipping cloud variable discovery', 'warning');
      return;
    }

    const cloudVars = Object.values(stage.variables)
      .filter(v => v.isCloud);
    
    this.log(`Found ${cloudVars.length} cloud variable(s) in project`, 'info');
    
    // Load existing values from Firebase
    const snapshot = await this.projectRef.once('value');
    const firebaseData = snapshot.val() || {};
    
    // Initialize each cloud variable
    for (const variable of cloudVars) {
      const name = variable.name;
      const firebaseValue = firebaseData[name];
      
      if (firebaseValue !== undefined && firebaseValue !== null) {
        // Use Firebase value (stored as string to prevent scientific notation)
        const valueStr = String(firebaseValue);
        this.cloudVariables.set(name, valueStr);
        this.lastValues.set(name, valueStr);
        variable.value = valueStr;
        this.log(`Synced \u2601 ${name} = ${valueStr} (from Firebase)`, 'debug');
      } else {
        // Use VM value and upload to Firebase (keep as string)
        const vmValue = String(variable.value || '0');
        this.cloudVariables.set(name, vmValue);
        this.lastValues.set(name, vmValue);
        await this.setCloudVariable(name, vmValue, true);
        this.log(`Synced \u2601 ${name} = ${vmValue} (from VM)`, 'debug');
      }
    }
  }

  setupFirebaseListeners() {
    this.projectRef.on('child_changed', (snapshot) => {
      const name = snapshot.key;
      const value = String(snapshot.val() || '0'); // Keep as string
      
      this.log(`Firebase update: \u2601 ${name} = ${value}`, 'debug');
      
      // Update local cache
      this.cloudVariables.set(name, value);
      this.lastValues.set(name, value);
      
      // Update VM
      this.updateVMVariable(name, value);
    });

    this.projectRef.on('child_added', (snapshot) => {
      const name = snapshot.key;
      const value = String(snapshot.val() || '0'); // Keep as string
      
      if (!this.cloudVariables.has(name)) {
        this.log(`New cloud variable: \u2601 ${name} = ${value}`, 'debug');
        this.cloudVariables.set(name, value);
        this.lastValues.set(name, value);
        this.updateVMVariable(name, value);
      }
    });
  }

  updateVMVariable(name, value) {
    const stage = this.vm.runtime.getTargetForStage();
    if (!stage) return;

    const variable = Object.values(stage.variables)
      .find(v => v.isCloud && v.name === name);
    
    if (variable && variable.value !== value) {
      variable.value = value;
      this.vm.runtime.requestRedraw();
    }
  }

  monitorCloudVariables() {
    // Direct monitoring of cloud variable value changes
    const stage = this.vm.runtime.getTargetForStage();
    if (!stage) return;

    const cloudVars = Object.values(stage.variables).filter(v => v.isCloud);
    
    for (const variable of cloudVars) {
      // Store the original value property descriptor
      const originalDescriptor = Object.getOwnPropertyDescriptor(variable, 'value') || {
        value: variable.value,
        writable: true,
        enumerable: true,
        configurable: true
      };

      let internalValue = variable.value;

      // Define a new property with getter/setter
      Object.defineProperty(variable, 'value', {
        get: function() {
          return internalValue;
        },
        set: (value) => {
          const oldValue = internalValue;
          internalValue = value;
          
          // Only sync if value actually changed
          if (String(oldValue) !== String(value)) {
            const valueStr = String(value || '0');
            this.log(`Direct value change: \u2601 ${variable.name} = ${valueStr}`, 'debug');
            this.handleCloudVariableChange(variable.name, valueStr);
          }
        },
        enumerable: true,
        configurable: true
      });
    }

    this.log('Direct cloud variable monitoring installed', 'success');
  }

  interceptVMCloudChanges() {
    // Hook into the VM's cloud variable setter
    const stage = this.vm.runtime.getTargetForStage();
    if (!stage) return;

    // Override setVariable for cloud variables
    const originalSetVariable = stage.setVariable;
    const self = this;
    
    stage.setVariable = function(id, value) {
      // First, call the original method to update the VM immediately
      const result = originalSetVariable.call(this, id, value);
      
      // Then check if it's a cloud variable and sync to Firebase
      const variable = this.variables[id];
      if (variable && variable.isCloud) {
        const valueStr = String(value || '0');
        self.log(`setVariable called: \u2601 ${variable.name} = ${valueStr}`, 'debug');
        self.handleCloudVariableChange(variable.name, valueStr);
      }
      
      return result;
    };

    this.log('VM setVariable interceptor installed', 'success');
  }

  handleCloudVariableChange(name, value) {
    // Debounce writes for UI input (prevents spam while typing)
    // But use a shorter debounce for better responsiveness
    if (this.debounceTimers.has(name)) {
      clearTimeout(this.debounceTimers.get(name));
    }
    
    const timer = setTimeout(() => {
      this.queueWrite(name, value);
      this.debounceTimers.delete(name);
    }, 100); // 100ms debounce (reduced from 300ms)
    
    this.debounceTimers.set(name, timer);
  }

  startPolling() {
    // Polling as a safety net to catch any missed updates
    this.pollingInterval = setInterval(() => {
      const stage = this.vm.runtime.getTargetForStage();
      if (!stage) return;

      const cloudVars = Object.values(stage.variables).filter(v => v.isCloud);
      
      for (const variable of cloudVars) {
        const currentValue = String(variable.value || '0');
        const lastValue = this.lastValues.get(variable.name);
        
        if (currentValue !== lastValue) {
          this.log(`Polling detected change: \u2601 ${variable.name} = ${currentValue}`, 'debug');
          this.lastValues.set(variable.name, currentValue);
          this.queueWrite(variable.name, currentValue);
        }
      }
    }, this.config.pollInterval);

    this.log('Polling monitor started', 'success');
  }

  queueWrite(name, value) {
    // Add to queue with rate limiting
    this.writeQueue.push({ name, value, timestamp: Date.now() });
    
    // Remove duplicates (keep only the latest value for each variable)
    const uniqueQueue = [];
    const seen = new Set();
    
    for (let i = this.writeQueue.length - 1; i >= 0; i--) {
      const item = this.writeQueue[i];
      if (!seen.has(item.name)) {
        seen.add(item.name);
        uniqueQueue.unshift(item);
      }
    }
    
    this.writeQueue = uniqueQueue;
  }

  startQueueProcessor() {
    setInterval(() => this.processQueue(), 100);
  }

  async processQueue() {
    if (this.isProcessingQueue || !this.connected || this.writeQueue.length === 0) {
      return;
    }

    this.isProcessingQueue = true;

    try {
      while (this.writeQueue.length > 0 && this.connected) {
        // Check rate limit
        const now = Date.now();
        this.rateLimitWindow = this.rateLimitWindow.filter(t => now - t < 1000);
        
        if (this.rateLimitWindow.length >= this.config.rateLimit) {
          this.log('Rate limit reached, waiting...', 'debug');
          break;
        }

        const item = this.writeQueue.shift();
        this.rateLimitWindow.push(now);
        
        await this.setCloudVariable(item.name, item.value);
      }
    } finally {
      this.isProcessingQueue = false;
    }
  }

  async setCloudVariable(name, value, skipQueue = false) {
    if (!skipQueue && !this.connected) {
      this.log(`Offline - queuing \u2601 ${name} = ${value}`, 'debug');
      this.queueWrite(name, value);
      return false;
    }

    const retryKey = name;
    const currentRetries = this.retryAttempts.get(retryKey) || 0;

    try {
      // Store as string to prevent scientific notation
      const valueStr = String(value);
      await this.projectRef.child(name).set(valueStr);
      this.cloudVariables.set(name, valueStr);
      this.lastValues.set(name, valueStr);
      this.retryAttempts.delete(retryKey);
      this.log(`\u2713 Set \u2601 ${name} = ${valueStr}`, 'debug');
      return true;
    } catch (error) {
      this.log(`\u2717 Error setting \u2601 ${name}: ${error.message}`, 'error');
      
      if (currentRetries < this.config.maxRetries) {
        this.retryAttempts.set(retryKey, currentRetries + 1);
        const delay = this.config.retryDelay * Math.pow(2, currentRetries);
        this.log(`Retrying in ${delay}ms (attempt ${currentRetries + 1}/${this.config.maxRetries})`, 'warning');
        
        setTimeout(() => {
          this.queueWrite(name, value);
        }, delay);
      } else {
        this.log(`Max retries reached for \u2601 ${name}`, 'error');
        this.retryAttempts.delete(retryKey);
      }
      
      return false;
    }
  }

  getCloudVariable(name) {
    return this.cloudVariables.get(name) || '0';
  }

  getAllCloudVariables() {
    return Object.fromEntries(this.cloudVariables);
  }

  isConnected() {
    return this.connected;
  }

  getStats() {
    return {
      connected: this.connected,
      queueLength: this.writeQueue.length,
      variableCount: this.cloudVariables.size,
      rateLimit: this.rateLimitWindow.length,
      lastSync: this.lastSync
    };
  }

  sanitizeProjectId(id) {
    return id.replace(/[.#$[\]\/]/g, '_');
  }

  disconnect() {
    // Clear polling
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    
    // Clear all debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    
    if (this.projectRef) {
      this.projectRef.off();
    }
    if (this.database) {
      this.database.ref('.info/connected').off();
    }
    this.connected = false;
    this.log('Disconnected', 'info');
  }
}

// Auto-initialize if config is provided in window
if (window.firebaseCloudConfig) {
  window.addEventListener('load', async () => {
    const { config, projectId, options } = window.firebaseCloudConfig;
    const cloudSystem = new FirebaseCloudSystem(config, projectId, options);
    await cloudSystem.initialize();
    window.firebaseCloudSystem = cloudSystem;
  });
}

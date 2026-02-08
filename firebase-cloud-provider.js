/**
 * Firebase Cloud Variable Provider for TurboWarp/Scratch
 * Replaces TurboWarp's WebSocket cloud servers with Firebase Realtime Database
 * This ensures your cloud variables persist permanently
 */

class FirebaseCloudProvider {
  constructor(firebaseConfig, projectId) {
    this.projectId = projectId;
    this.firebaseConfig = firebaseConfig;
    this.database = null;
    this.cloudVariables = new Map();
    this.listeners = new Set();
    this.connected = false;
    this.projectRef = null;
  }

  async initialize() {
    try {
      // Initialize Firebase
      const app = firebase.initializeApp(this.firebaseConfig);
      this.database = firebase.database(app);
      
      // Create reference to this project's cloud variables
      this.projectRef = this.database.ref(`projects/${this.sanitizeProjectId(this.projectId)}/variables`);
      
      // Listen for changes from other users
      this.projectRef.on('value', (snapshot) => {
        const data = snapshot.val() || {};
        
        // Update local cache and notify listeners
        for (const [varName, value] of Object.entries(data)) {
          const oldValue = this.cloudVariables.get(varName);
          if (oldValue !== value) {
            this.cloudVariables.set(varName, value);
            this.notifyListeners(varName, value);
          }
        }
        
        if (!this.connected) {
          this.connected = true;
          console.log('✓ Connected to Firebase cloud variables');
        }
      });

      // Handle disconnection
      this.database.ref('.info/connected').on('value', (snapshot) => {
        this.connected = snapshot.val() === true;
        console.log(this.connected ? '✓ Firebase connected' : '⚠ Firebase disconnected');
      });

      return true;
    } catch (error) {
      console.error('Failed to initialize Firebase cloud provider:', error);
      return false;
    }
  }

  sanitizeProjectId(id) {
    // Firebase keys can't contain . # $ [ ] or /
    return id.replace(/[.#$[\]\/]/g, '_');
  }

  async setCloudVariable(name, value) {
    if (!this.projectRef) {
      console.error('Firebase not initialized');
      return false;
    }

    try {
      // Update Firebase
      await this.projectRef.child(name).set(value);
      
      // Update local cache
      this.cloudVariables.set(name, value);
      
      return true;
    } catch (error) {
      console.error(`Error setting cloud variable ${name}:`, error);
      return false;
    }
  }

  getCloudVariable(name) {
    return this.cloudVariables.get(name) || 0;
  }

  async getAllCloudVariables() {
    if (!this.projectRef) {
      return {};
    }

    try {
      const snapshot = await this.projectRef.once('value');
      return snapshot.val() || {};
    } catch (error) {
      console.error('Error getting all cloud variables:', error);
      return {};
    }
  }

  onCloudVariableChange(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  notifyListeners(name, value) {
    for (const callback of this.listeners) {
      try {
        callback(name, value);
      } catch (error) {
        console.error('Error in cloud variable listener:', error);
      }
    }
  }

  isConnected() {
    return this.connected;
  }

  disconnect() {
    if (this.projectRef) {
      this.projectRef.off();
    }
    if (this.database) {
      this.database.ref('.info/connected').off();
    }
    this.connected = false;
    this.listeners.clear();
  }
}

// Adapter to make Firebase provider work with Scaffolding's cloud system
class FirebaseCloudAdapter {
  constructor(firebaseConfig, projectId) {
    this.provider = new FirebaseCloudProvider(firebaseConfig, projectId);
    this.initialized = false;
  }

  async initialize() {
    this.initialized = await this.provider.initialize();
    return this.initialized;
  }

  // Scaffolding expects these methods
  setVariable(name, value) {
    // Cloud variables in Scratch are numbers only
    const numValue = Number(value) || 0;
    return this.provider.setCloudVariable(name, numValue);
  }

  createVariable(name, initialValue) {
    return this.provider.setCloudVariable(name, initialValue || 0);
  }

  renameVariable(oldName, newName) {
    const value = this.provider.getCloudVariable(oldName);
    this.provider.setCloudVariable(newName, value);
    // Note: We don't delete the old variable to preserve data
  }

  deleteVariable(name) {
    // Optional: Implement if you want to remove variables
    console.log(`Delete variable ${name} - not implemented to preserve data`);
  }

  requestCloseConnection() {
    this.provider.disconnect();
  }
}

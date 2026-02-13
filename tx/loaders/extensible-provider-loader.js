/**
 * ExtensibleProviderLoader
 *
 * Dynamically loads external CodeSystem provider packages.
 * Enables FHIRsmith to support providers without modifying core library.js
 *
 * Usage:
 *   const loader = new ExtensibleProviderLoader(config, i18n);
 *   const providers = await loader.loadAll();
 *   // Each provider factory is ready to use
 *
 * Configuration (config.json):
 *   {
 *     "externalPackages": ["@genomics/codesystem-providers"]
 *   }
 *
 * Package format (node_modules/@genomics/codesystem-providers):
 *   index.js exports:
 *   {
 *     version: "0.1.0",
 *     providers: [RefSeqFactory, HGNCFactory, ...]
 *   }
 */

class ExtensibleProviderLoader {
  constructor(config = {}, i18n = null) {
    this.config = config;
    this.i18n = i18n;
    this.externalPackages = config.externalPackages || [];
    this.loadedProviders = [];
    this.statistics = {
      packagesLoaded: 0,
      providersRegistered: 0,
      errors: []
    };
  }

  /**
   * Load all external provider packages
   * @returns {Promise<Array>} Array of loaded provider factories
   */
  async loadAll() {
    const providers = [];

    for (const packageName of this.externalPackages) {
      try {
        const packageModule = await this._loadPackage(packageName);
        const packageProviders = await this._registerPackage(packageModule, packageName);
        
        providers.push(...packageProviders);
        this.statistics.packagesLoaded++;
        this.statistics.providersRegistered += packageProviders.length;
      } catch (error) {
        const errorMsg = `Failed to load external package '${packageName}': ${error.message}`;
        console.error(`[ExtensibleProviderLoader] ${errorMsg}`);
        this.statistics.errors.push(errorMsg);
        // Continue loading other packages even if one fails
      }
    }

    this.loadedProviders = providers;
    return providers;
  }

  /**
   * Load a single NPM package
   * @private
   * @param {string} packageName - NPM package name (e.g., @genomics/codesystem-providers)
   * @returns {Promise<object>} Loaded module
   * @throws {Error} If package cannot be loaded
   */
  async _loadPackage(packageName) {
    try {
      // Attempt to require the package
      // In Node.js this is synchronous, but wrapped in Promise for consistency
      return new Promise((resolve, reject) => {
        try {
          const module = require(packageName);
          resolve(module);
        } catch (error) {
          reject(new Error(`Package '${packageName}' not found. Install with: npm install ${packageName}`));
        }
      });
    } catch (error) {
      throw error;
    }
  }

  /**
   * Register providers from a loaded package
   * @private
   * @param {object} packageModule - Loaded package module
   * @param {string} packageName - Package name for logging
   * @returns {Promise<Array>} Array of provider factories (instantiated)
   */
  async _registerPackage(packageModule, packageName) {
    // Check if package has initializeProviders function
    if (typeof packageModule.initializeProviders === 'function') {
      // Pass FHIRsmith base classes to the package
      const { CodeSystemProvider, CodeSystemFactoryProvider } = require('../cs/cs-api');
      const providerClasses = packageModule.initializeProviders({
        CodeSystemProvider,
        CodeSystemFactoryProvider
      });
      
      if (!Array.isArray(providerClasses)) {
        throw new Error(`initializeProviders() must return an array. Got: ${typeof providerClasses}`);
      }
      
      // Log package metadata
      if (packageModule.version) {
        console.log(`[ExtensibleProviderLoader] Loaded ${packageName} v${packageModule.version} (${providerClasses.length} providers)`);
      }
      
      // Instantiate each provider factory class
      const providerInstances = [];
      for (const ProviderClass of providerClasses) {
        if (typeof ProviderClass !== 'function') {
          throw new Error(`Provider must be a class/constructor. Got: ${typeof ProviderClass}`);
        }
        
        const instance = new ProviderClass(this.i18n);
        
        if (typeof instance.system !== 'function' || typeof instance.build !== 'function') {
          throw new Error(
            `Provider instance must have 'system()' and 'build()' methods. ` +
            `Got: ${Object.getOwnPropertyNames(Object.getPrototypeOf(instance)).join(', ')}`
          );
        }
        
        providerInstances.push(instance);
      }
      
      return providerInstances;
    }
    
    // Fallback to old approach (for backward compatibility)
    if (!packageModule.providers || !Array.isArray(packageModule.providers)) {
      throw new Error(`Package must export 'providers' array or 'initializeProviders()' function. Got: ${Object.keys(packageModule).join(', ')}`);
    }

    const providerClasses = packageModule.providers;
    const providerInstances = [];

    // Optional: Log package metadata
    if (packageModule.version) {
      console.log(`[ExtensibleProviderLoader] Loaded ${packageName} v${packageModule.version} (${providerClasses.length} providers)`);
    }

    // Instantiate each provider factory class
    for (const ProviderClass of providerClasses) {
      // Check if it's a class (constructor function)
      if (typeof ProviderClass !== 'function') {
        throw new Error(
          `Provider from '${packageName}' must be a class/constructor. ` +
          `Got: ${typeof ProviderClass}`
        );
      }

      // Instantiate with i18n
      const instance = new ProviderClass(this.i18n);
      
      // Optional: Validate instance has required methods
      if (typeof instance.system !== 'function' || typeof instance.build !== 'function') {
        throw new Error(
          `Provider instance from '${packageName}' must have 'system()' and 'build()' methods. ` +
          `Got: ${Object.getOwnPropertyNames(Object.getPrototypeOf(instance)).join(', ')}`
        );
      }

      providerInstances.push(instance);
    }

    return providerInstances;
  }

  /**
   * Get statistics about loaded packages
   * @returns {object} Statistics including count and errors
   */
  getStatistics() {
    return {
      ...this.statistics,
      providersLoaded: this.loadedProviders.length
    };
  }

  /**
   * Check if a package has errors
   * @returns {boolean} True if any errors occurred
   */
  hasErrors() {
    return this.statistics.errors.length > 0;
  }

  /**
   * Get all errors that occurred during loading
   * @returns {Array<string>} Array of error messages
   */
  getErrors() {
    return [...this.statistics.errors];
  }
}

module.exports = { ExtensibleProviderLoader };

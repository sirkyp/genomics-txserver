/**
 * CodeSystemLoader
 *
 * Handles dynamic provider loading during FHIR package CodeSystem loading.
 * Called from Library.loadNpm / Library.loadUrl after each CodeSystem resource
 * is parsed.
 *
 * Responsibilities:
 *  Dynamically load a provider class that is wired to a CodeSystem via the
 *  `http://hl7.org/fhir/StructureDefinition/codesystem-provider-class`
 *  extension (used by terminology packages for API-backed systems)
 */

'use strict';

const path = require('path');
const { Extensions } = require('../library/extensions');
const { CodeSystemProvider, CodeSystemFactoryProvider } = require('../cs/cs-api');

class CodeSystemProviderLoader {
  /**
   * Called once per CodeSystem resource during package loading.
   * Tries to load an attached provider class if one is specified.
   *
   * @param {CodeSystem}           cs               - Parsed CodeSystem wrapper
   * @param {PackageContentLoader} contentLoader     - The package being loaded
   * @param {string}               providerBasePath  - Absolute path to `package/` dir
   * @param {Library}              library           - Library instance (provides
   *                                                   registerProvider, i18n, log)
   */
  static async processCodeSystem(cs, contentLoader, providerBasePath, library) {
    await CodeSystemProviderLoader.loadProviderFromCodeSystem(
      cs,
      contentLoader,
      providerBasePath,
      library
    );
  }

  /**
   * Dynamically loads a CodeSystem provider class referenced by the
   * `http://hl7.org/fhir/StructureDefinition/codesystem-provider-class`
   * extension on a `content=not-present` CodeSystem.
   *
   * The extension value is a relative (or absolute) path to a JS module that
   * exports a CodeSystemFactoryProvider subclass. After loading, the factory
   * is registered with the Library.
   *
   * @param {CodeSystem}           codeSystem
   * @param {PackageContentLoader} contentLoader
   * @param {string}               packagePath  - Path used to resolve relative module paths
   * @param {Library}              library
   */
  static async loadProviderFromCodeSystem(codeSystem, contentLoader, packagePath, library) {
    if (!codeSystem || !codeSystem.jsonObj) {
      return;
    }

    // Only `not-present` CodeSystems need a provider class; all others have
    // their concepts stored directly in the package.
    if (codeSystem.jsonObj.content !== 'not-present') {
      return;
    }

    const providerModulePath = Extensions.readString(
      codeSystem.jsonObj,
      'http://hl7.org/fhir/StructureDefinition/codesystem-provider-class'
    );

    if (!providerModulePath) {
      return;
    }

    try {
      // Expose base classes globally so provider modules can inherit from them
      // without needing a direct dependency on the FHIRsmith core package.
      global.__FHIRSMITH_BASE_CLASSES__ = {
        CodeSystemProvider,
        CodeSystemFactoryProvider
      };

      const resolvedPath = path.isAbsolute(providerModulePath)
        ? providerModulePath
        : path.join(packagePath, providerModulePath);

      const moduleExports = require(resolvedPath);
      const exportName = path.basename(providerModulePath, path.extname(providerModulePath));

      let ProviderClass = null;
      if (typeof moduleExports === 'function') {
        ProviderClass = moduleExports;
      } else if (moduleExports && typeof moduleExports.default === 'function') {
        ProviderClass = moduleExports.default;
      } else if (moduleExports && typeof moduleExports[exportName] === 'function') {
        ProviderClass = moduleExports[exportName];
      }

      if (!ProviderClass) {
        library.log.warn(
          `Unable to resolve provider class '${providerModulePath}' in ` +
          `package ${contentLoader.id()}#${contentLoader.version()}`
        );
        return;
      }

      const factory = new ProviderClass(library.i18n);
      if (typeof factory.load === 'function') {
        await factory.load();
      }

      if (factory.system && factory.system() !== codeSystem.url) {
        library.log.warn(
          `Provider system mismatch for ${contentLoader.id()}#${contentLoader.version()}: ` +
          `${factory.system()} does not match CodeSystem.url ${codeSystem.url}`
        );
        return;
      }

      library.registerProvider(`npm:${contentLoader.id()}`, factory);
      library.log.info(
        `Loaded provider ${providerModulePath} for ${codeSystem.url} ` +
        `from ${contentLoader.id()}#${contentLoader.version()}`
      );
    } catch (error) {
      library.log.warn(
        `Failed to load provider '${providerModulePath}' from ` +
        `${contentLoader.id()}#${contentLoader.version()}: ${error.message}`
      );
    }
  }
}

module.exports = { CodeSystemProviderLoader };

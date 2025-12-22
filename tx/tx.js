//
// TX Module - FHIR Terminology Server
//
// This module provides FHIR terminology services (CodeSystem, ValueSet, ConceptMap)
// with support for multiple endpoints at different FHIR versions.
//

const express = require('express');
const path = require('path');
const Logger = require('../common/logger');
const { Library } = require('./library');
const { OperationContext } = require('./operation-context');
const { LanguageDefinitions } = require('../library/languages');
const { I18nSupport } = require('../library/i18nsupport');
const txHtml = require('./tx-html');

// Import workers
const ReadWorker = require('./workers/read');
const SearchWorker = require('./workers/search');
const ExpandWorker = require('./workers/expand');
const ValidateWorker = require('./workers/validate');
const TranslateWorker = require('./workers/translate');
const LookupWorker = require('./workers/lookup');
const SubsumesWorker = require('./workers/subsumes');
const ClosureWorker = require('./workers/closure');

class TXModule {
  constructor() {
    this.log = Logger.getInstance().child({ module: 'tx' });
    this.config = null;
    this.library = null;
    this.endpoints = [];
    this.routers = new Map(); // path -> router
    this.requestIdCounter = 0; // Thread-safe request ID counter
    this.languages = null; // LanguageDefinitions
    this.i18n = null; // I18nSupport
  }

  /**
   * Generate a unique request ID
   * @returns {string} Unique request ID
   */
  generateRequestId() {
    this.requestIdCounter++;
    return `tx-${this.requestIdCounter}`;
  }

  /**
   * Initialize the TX module
   * @param {Object} config - Module configuration
   * @param {express.Application} app - Express application for registering endpoints
   */
  async initialize(config, app) {
    this.config = config;
    this.log.info('Initializing TX module');

    // Load HTML template
    txHtml.loadTemplate();

    // Validate config
    if (!config.librarySource) {
      throw new Error('TX module requires librarySource configuration');
    }

    if (!config.endpoints || !Array.isArray(config.endpoints) || config.endpoints.length === 0) {
      throw new Error('TX module requires at least one endpoint configuration');
    }

    // Load language definitions
    const langPath = path.join(__dirname, 'data', 'lang.dat');
    this.log.info(`Loading language definitions from: ${langPath}`);
    this.languages = await LanguageDefinitions.fromFile(langPath);
    this.log.info('Language definitions loaded');

    // Initialize i18n support
    const translationsPath = path.join(__dirname, '..', 'translations');
    this.log.info(`Loading translations from: ${translationsPath}`);
    this.i18n = new I18nSupport(translationsPath, this.languages);
    this.log.info('I18n support initialized');

    // Load the library from YAML
    this.log.info(`Loading library from: ${config.librarySource}`);
    this.library = new Library(config.librarySource);
    await this.library.load();
    this.log.info('Library loaded successfully');

    // Set up each endpoint
    for (const endpoint of config.endpoints) {
      await this.setupEndpoint(endpoint, app);
    }

    this.log.info(`TX module initialized with ${config.endpoints.length} endpoint(s)`);
  }

  /**
   * Set up a single endpoint
   * @param {Object} endpoint - Endpoint configuration {path, fhirVersion, context}
   * @param {express.Application} app - Express application
   */
  async setupEndpoint(endpoint, app) {
    const { path: endpointPath, context } = endpoint;
    const fhirVersion = String(endpoint.fhirVersion);

    if (!endpointPath) {
      throw new Error('Endpoint requires a path');
    }

    if (!fhirVersion) {
      throw new Error(`Endpoint ${endpointPath} requires a fhirVersion`);
    }

    // Check for path conflicts
    if (this.routers.has(endpointPath)) {
      throw new Error(`Duplicate endpoint path: ${endpointPath}`);
    }

    this.log.info(`Setting up endpoint: ${endpointPath} (FHIR v${fhirVersion}, context: ${context || 'none'})`);

    // Create the provider once for this endpoint
    const provider = await this.library.cloneWithFhirVersion(fhirVersion, context);

    const router = express.Router();

    // Store endpoint info for provider creation
    const endpointInfo = {
      path: endpointPath,
      fhirVersion,
      context: context || null
    };

    // Middleware to attach provider, context, and timing to request, and wrap res.json for HTML
    router.use((req, res, next) => {
      // Generate unique request ID
      const requestId = this.generateRequestId();

      // Get Accept-Language header for language preferences
      const acceptLanguage = req.get('Accept-Language') || 'en';

      // Create operation context with language, ID, and default time limit (30s)
      const opContext = new OperationContext(acceptLanguage, requestId, 30);

      // Attach everything to request
      req.txProvider = provider;
      req.txEndpoint = endpointInfo;
      req.txStartTime = Date.now();
      req.txOpContext = opContext;
      req.txLanguages = this.languages;
      req.txI18n = this.i18n;
      req.txLog = this.log;

      // Add X-Request-Id header to response
      res.setHeader('X-Request-Id', requestId);

      // Wrap res.json to intercept and convert to HTML if browser requests it, and log the request
      const originalJson = res.json.bind(res);
      const log = this.log;

      res.json = (data) => {
        const duration = Date.now() - req.txStartTime;
        const operation = `${req.method} ${req.baseUrl}${req.path}`;
        const params = req.method === 'POST' ? req.body : req.query;
        const isHtml = txHtml.acceptsHtml(req);

        let responseSize;
        let result;

        if (isHtml) {
          const title = txHtml.buildTitle(data);
          const content = txHtml.render(data, req);
          const html = txHtml.renderPage(title, content, req.txEndpoint, req.txStartTime);
          responseSize = Buffer.byteLength(html, 'utf8');
          res.setHeader('Content-Type', 'text/html');
          result = res.send(html);
        } else {
          const jsonStr = JSON.stringify(data);
          responseSize = Buffer.byteLength(jsonStr, 'utf8');
          result = originalJson(data);
        }

        // Log the request with request ID
        const paramStr = Object.keys(params).length > 0 ? ` params=${JSON.stringify(params)}` : '';
        log.info(`[${requestId}] ${operation}${paramStr} - ${res.statusCode} - ${isHtml ? 'html' : 'json'} - ${responseSize} bytes - ${duration}ms`);

        return result;
      };

      next();
    });

    // CORS headers
    router.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
      res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
      }
      next();
    });

    // Set up routes
    this.setupRoutes(router);

    // Register the router with the app
    app.use(endpointPath, router);
    this.routers.set(endpointPath, router);
    this.endpoints.push(endpointInfo);

    this.log.info(`Endpoint ${endpointPath} registered`);
  }

  /**
   * Set up routes for an endpoint
   * @param {express.Router} router - Express router
   */
  setupRoutes(router) {
    const resourceTypes = ['CodeSystem', 'ValueSet', 'ConceptMap'];

    // ===== Operations =====

    // CodeSystem/$lookup (GET and POST)
    router.get('/CodeSystem/\\$lookup', (req, res) => {
      let worker = new LookupWorker(req.txOpContext, this.log, req.txProvider, this.languages, this.i18n);
      worker.handle(req, res);
    });
    router.post('/CodeSystem/\\$lookup', (req, res) => {
      let worker = new LookupWorker(req.txOpContext, this.log, req.txProvider, this.languages, this.i18n);
      worker.handle(req, res);
    });

    // CodeSystem/$subsumes (GET and POST)
    router.get('/CodeSystem/\\$subsumes', (req, res) => {
      SubsumesWorker.handle(req, res);
    });
    router.post('/CodeSystem/\\$subsumes', (req, res) => {
      SubsumesWorker.handle(req, res);
    });

    // CodeSystem/$validate-code (GET and POST)
    router.get('/CodeSystem/\\$validate-code', (req, res) => {
      ValidateWorker.handleCodeSystem(req, res);
    });
    router.post('/CodeSystem/\\$validate-code', (req, res) => {
      ValidateWorker.handleCodeSystem(req, res);
    });

    // ValueSet/$validate-code (GET and POST)
    router.get('/ValueSet/\\$validate-code', (req, res) => {
      ValidateWorker.handleValueSet(req, res);
    });
    router.post('/ValueSet/\\$validate-code', (req, res) => {
      ValidateWorker.handleValueSet(req, res);
    });

    // ValueSet/$expand (GET and POST)
    router.get('/ValueSet/\\$expand', (req, res) => {
      ExpandWorker.handle(req, res, this.log);
    });
    router.post('/ValueSet/\\$expand', (req, res) => {
      ExpandWorker.handle(req, res, this.log);
    });

    // ConceptMap/$translate (GET and POST)
    router.get('/ConceptMap/\\$translate', (req, res) => {
      TranslateWorker.handle(req, res, this.log);
    });
    router.post('/ConceptMap/\\$translate', (req, res) => {
      TranslateWorker.handle(req, res, this.log);
    });

    // ConceptMap/$closure (GET and POST)
    router.get('/ConceptMap/\\$closure', (req, res) => {
      ClosureWorker.handle(req, res, this.log);
    });
    router.post('/ConceptMap/\\$closure', (req, res) => {
      ClosureWorker.handle(req, res, this.log);
    });

    // ===== Instance operations =====

    // CodeSystem/[id]/$lookup
    router.get('/CodeSystem/:id/\\$lookup', (req, res) => {
      let worker = new LookupWorker(req.txOpContext, this.log, req.txProvider, this.languages, this.i18n);
      worker.handleInstance(req, res);
    });
    router.post('/CodeSystem/:id/\\$lookup', (req, res) => {
      let worker = new LookupWorker(req.txOpContext, this.log, req.txProvider, this.languages, this.i18n);
      worker.handleInstance(req, res);
    });

    // CodeSystem/[id]/$subsumes
    router.get('/CodeSystem/:id/\\$subsumes', (req, res) => {
      SubsumesWorker.handleInstance(req, res, this.log);
    });
    router.post('/CodeSystem/:id/\\$subsumes', (req, res) => {
      SubsumesWorker.handleInstance(req, res, this.log);
    });

    // CodeSystem/[id]/$validate-code
    router.get('/CodeSystem/:id/\\$validate-code', (req, res) => {
      ValidateWorker.handleCodeSystemInstance(req, res, this.log);
    });
    router.post('/CodeSystem/:id/\\$validate-code', (req, res) => {
      ValidateWorker.handleCodeSystemInstance(req, res, this.log);
    });

    // ValueSet/[id]/$validate-code
    router.get('/ValueSet/:id/\\$validate-code', (req, res) => {
      ValidateWorker.handleValueSetInstance(req, res, this.log);
    });
    router.post('/ValueSet/:id/\\$validate-code', (req, res) => {
      ValidateWorker.handleValueSetInstance(req, res, this.log);
    });

    // ValueSet/[id]/$expand
    router.get('/ValueSet/:id/\\$expand', (req, res) => {
      ExpandWorker.handleInstance(req, res, this.log);
    });
    router.post('/ValueSet/:id/\\$expand', (req, res) => {
      ExpandWorker.handleInstance(req, res, this.log);
    });

    // ConceptMap/[id]/$translate
    router.get('/ConceptMap/:id/\\$translate', (req, res) => {
      TranslateWorker.handleInstance(req, res, this.log);
    });
    router.post('/ConceptMap/:id/\\$translate', (req, res) => {
      TranslateWorker.handleInstance(req, res, this.log);
    });

    // ===== Read and Search =====

    // Read: GET /[type]/[id]
    for (const resourceType of resourceTypes) {
      router.get(`/${resourceType}/:id`, (req, res) => {
        // Skip if id starts with $ (it's an operation)
        if (req.params.id.startsWith('$')) {
          return res.status(404).json(this.operationOutcome(
            'error',
            'not-found',
            `Unknown operation: ${req.params.id}`
          ));
        }
        let worker = new ReadWorker(req.txOpContext, this.log, req.txProvider, this.languages, this.i18n);
        worker.handle(req, res, resourceType);
      });
    }

    // Search: GET /[type]
    for (const resourceType of resourceTypes) {
      router.get(`/${resourceType}`, (req, res) => {
        let worker = new SearchWorker(req.txOpContext, this.log, req.txProvider, this.languages, this.i18n);
        worker.handle(req, res, resourceType);
      });
      router.post(`/${resourceType}/_search`, (req, res) => {
        let worker = new SearchWorker(req.txOpContext, this.log, req.txProvider, this.languages, this.i18n);
        worker.handle(req, res, resourceType);
      });
    }

    // Unsupported methods
    for (const resourceType of resourceTypes) {
      router.all(`/${resourceType}/:id`, (req, res) => {
        if (['PUT', 'POST', 'DELETE', 'PATCH'].includes(req.method)) {
          return res.status(405).json(this.operationOutcome(
            'error',
            'not-supported',
            `Method ${req.method} is not supported`
          ));
        }
      });
    }

    // Metadata / CapabilityStatement
    router.get('/metadata', (req, res) => {
      res.json(this.buildCapabilityStatement(req.txEndpoint));
    });

    // Root endpoint info
    router.get('/', (req, res) => {
      res.json({
        resourceType: 'OperationOutcome',
        issue: [{
          severity: 'information',
          code: 'informational',
          diagnostics: `FHIR Terminology Server - FHIR v${req.txEndpoint.fhirVersion}`
        }]
      });
    });
  }

  /**
   * Build a CapabilityStatement for an endpoint
   */
  buildCapabilityStatement(endpoint) {
    const fhirVersionMap = {
      '3.0': '3.0.2',
      '4.0': '4.0.1',
      '5.0': '5.0.0',
      '6.0': '6.0.0'
    };

    return {
      resourceType: 'CapabilityStatement',
      status: 'active',
      date: new Date().toISOString(),
      kind: 'instance',
      software: {
        name: 'TX FHIR Terminology Server',
        version: '1.0.0'
      },
      fhirVersion: fhirVersionMap[endpoint.fhirVersion] || '4.0.1',
      format: ['json'],
      rest: [{
        mode: 'server',
        resource: [
          {
            type: 'CodeSystem',
            interaction: [
              { code: 'read' },
              { code: 'search-type' }
            ],
            searchParam: [
              { name: 'url', type: 'uri' },
              { name: 'version', type: 'token' },
              { name: 'name', type: 'string' },
              { name: 'title', type: 'string' },
              { name: 'status', type: 'token' }
            ],
            operation: [
              { name: 'lookup', definition: 'http://hl7.org/fhir/OperationDefinition/CodeSystem-lookup' },
              { name: 'validate-code', definition: 'http://hl7.org/fhir/OperationDefinition/CodeSystem-validate-code' },
              { name: 'subsumes', definition: 'http://hl7.org/fhir/OperationDefinition/CodeSystem-subsumes' }
            ]
          },
          {
            type: 'ValueSet',
            interaction: [
              { code: 'read' },
              { code: 'search-type' }
            ],
            searchParam: [
              { name: 'url', type: 'uri' },
              { name: 'version', type: 'token' },
              { name: 'name', type: 'string' },
              { name: 'title', type: 'string' },
              { name: 'status', type: 'token' }
            ],
            operation: [
              { name: 'expand', definition: 'http://hl7.org/fhir/OperationDefinition/ValueSet-expand' },
              { name: 'validate-code', definition: 'http://hl7.org/fhir/OperationDefinition/ValueSet-validate-code' }
            ]
          },
          {
            type: 'ConceptMap',
            interaction: [
              { code: 'read' },
              { code: 'search-type' }
            ],
            searchParam: [
              { name: 'url', type: 'uri' },
              { name: 'version', type: 'token' },
              { name: 'name', type: 'string' },
              { name: 'title', type: 'string' },
              { name: 'status', type: 'token' }
            ],
            operation: [
              { name: 'translate', definition: 'http://hl7.org/fhir/OperationDefinition/ConceptMap-translate' },
              { name: 'closure', definition: 'http://hl7.org/fhir/OperationDefinition/ConceptMap-closure' }
            ]
          }
        ]
      }]
    };
  }

  /**
   * Build an OperationOutcome for errors
   */
  operationOutcome(severity, code, message) {
    return {
      resourceType: 'OperationOutcome',
      issue: [{
        severity,
        code,
        diagnostics: message
      }]
    };
  }

  /**
   * Get module status for health check
   */
  getStatus() {
    return {
      enabled: true,
      status: this.library ? 'Running' : 'Not initialized',
      endpoints: this.endpoints.map(e => ({
        path: e.path,
        fhirVersion: e.fhirVersion,
        context: e.context
      }))
    };
  }

  /**
   * Shutdown the module
   */
  async shutdown() {
    this.log.info('Shutting down TX module');
    // Clean up any resources if needed
    this.log.info('TX module shut down');
  }
}

module.exports = TXModule;
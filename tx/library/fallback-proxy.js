//
// Fallback Proxy - Forwards unknown code systems to tx.fhir.org
//

const axios = require('axios');
const Logger = require('../../library/logger');
const log = Logger.getInstance().child({ module: 'fallback-proxy' });

class FallbackProxy {
  constructor(config) {
    this.enabled = config?.fallback?.enabled || false;
    this.server = config?.fallback?.server || 'https://tx.fhir.org';
    this.supportedSystems = new Set();
    
    if (this.enabled) {
      log.info(`Fallback proxy enabled: ${this.server}`);
    }
  }

  /**
   * Register a locally-supported CodeSystem URL (called by Library after loading)
   * @param {string} url - CodeSystem URL
   */
  addSupportedSystem(url) {
    if (url && !this.supportedSystems.has(url)) {
      this.supportedSystems.add(url);
    }
  }

  /**
   * Get count of registered locally-supported systems
   * @returns {number}
   */
  getSupportedSystemCount() {
    return this.supportedSystems.size;
  }

  /**
   * Check if a code system is supported locally (not requiring fallback)
   */
  isSupportedSystem(systemUrl) {
    if (!systemUrl) return false;
    
    // Check exact match or prefix match
    for (const supportedSystem of this.supportedSystems) {
      if (systemUrl === supportedSystem || systemUrl.startsWith(supportedSystem)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Extract the system parameter from FHIR Parameters resource or query params
   */
  extractSystem(params) {
    // Check direct parameter (from query string)
    if (params.system) {
      return params.system;
    }

    // Check FHIR Parameters resource (from POST body)
    if (params.parameter && Array.isArray(params.parameter)) {
      const systemParam = params.parameter.find(p => p.name === 'system');
      if (systemParam) {
        return systemParam.valueUri || systemParam.valueString;
      }

      const codingParam = params.parameter.find(p => p.name === 'coding');
      if (codingParam?.valueCoding?.system) {
        return codingParam.valueCoding.system;
      }

      const codeableConceptParam = params.parameter.find(p => p.name === 'codeableConcept');
      if (codeableConceptParam?.valueCodeableConcept?.coding?.[0]?.system) {
        return codeableConceptParam.valueCodeableConcept.coding[0].system;
      }
    }

    // Check Coding
    if (params.coding) {
      return params.coding.system;
    }

    // Check CodeableConcept
    if (params.codeableConcept?.coding?.[0]) {
      return params.codeableConcept.coding[0].system;
    }

    return null;
  }

  /**
   * Proxy a request to tx.fhir.org
   */
  async proxyRequest(req, res) {
    if (!this.enabled) {
      return this.sendNotSupported(res);
    }

    try {
      // Use originalUrl to get full path including FHIR version
      // Our endpoints are /tx/r4/... or /tx/r5/... 
      // tx.fhir.org expects /r4/... or /r5/...
      // So strip the /tx prefix
      const targetPath = req.originalUrl.replace(/^\/tx/, '').split('?')[0]; // Remove query params, will pass via params
      const targetUrl = `${this.server}${targetPath}`;
      log.info(`Proxying to ${targetUrl}`);

      // Forward most headers, excluding problematic ones
      const headersToExclude = ['host', 'connection', 'content-length', 'transfer-encoding', 'accept-encoding'];
      const forwardedHeaders = {};
      Object.keys(req.headers).forEach(header => {
        if (!headersToExclude.includes(header.toLowerCase())) {
          forwardedHeaders[header] = req.headers[header];
        }
      });

      // Ensure required headers are set properly
      forwardedHeaders['Accept'] = 'application/fhir+json';
      forwardedHeaders['Content-Type'] = 'application/fhir+json';

      const axiosConfig = {
        method: req.method,
        url: targetUrl,
        params: req.query,
        headers: forwardedHeaders,
        timeout: 30000,
        validateStatus: () => true // Accept any status code
      };

      // Include body for POST/PUT requests
      if (req.body && (req.method === 'POST' || req.method === 'PUT')) {
        axiosConfig.data = req.body;
      }

      const response = await axios(axiosConfig);

      // Forward response
      res.status(response.status);
      Object.keys(response.headers).forEach(header => {
        if (header.toLowerCase() !== 'transfer-encoding') { // Skip problematic headers
          res.setHeader(header, response.headers[header]);
        }
      });
      res.send(response.data);

    } catch (error) {
      // If the error is an HTTP response with FHIR OperationOutcome, forward it
      if (error.response && error.response.data) {
        const data = error.response.data;
        // Check if it's a FHIR OperationOutcome
        if (typeof data === 'object' && data.resourceType === 'OperationOutcome') {
          log.info(`Fallback server returned OperationOutcome (status ${error.response.status}): ${JSON.stringify(data.issue[0])}`);
          res.status(error.response.status);
          Object.keys(error.response.headers).forEach(header => {
            if (header.toLowerCase() !== 'transfer-encoding') {
              res.setHeader(header, error.response.headers[header]);
            }
          });
          return res.send(data);
        }
      }
      
      log.error(`Fallback proxy error: ${error.message}`);
      this.sendError(res, error);
    }
  }

  sendNotSupported(res) {
    res.status(404).json({
      resourceType: 'OperationOutcome',
      issue: [{
        severity: 'error',
        code: 'not-supported',
        diagnostics: 'Code system not supported by this server and fallback is disabled'
      }]
    });
  }

  sendError(res, error) {
    res.status(500).json({
      resourceType: 'OperationOutcome',
      issue: [{
        severity: 'error',
        code: 'exception',
        diagnostics: `Fallback proxy error: ${error.message}`
      }]
    });
  }
}

module.exports = { FallbackProxy };

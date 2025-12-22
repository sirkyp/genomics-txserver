//
// Subsumes Worker - Handles CodeSystem $subsumes operation
//
// GET /CodeSystem/$subsumes?{params}
// POST /CodeSystem/$subsumes
// GET /CodeSystem/{id}/$subsumes?{params}
// POST /CodeSystem/{id}/$subsumes
//

class SubsumesWorker {
  /**
   * Handle a type-level $subsumes request
   * @param {express.Request} req - Express request (with txProvider attached)
   * @param {express.Response} res - Express response
   * @param {Object} log - Logger instance
   */
  static handle(req, res, log) {
    const provider = req.txProvider;
    const params = req.method === 'POST' ? req.body : req.query;

    log.debug('CodeSystem $subsumes with params:', params);

    // TODO: Implement subsumes logic using provider
    res.status(501).json({
      resourceType: 'OperationOutcome',
      issue: [{
        severity: 'error',
        code: 'not-supported',
        diagnostics: 'CodeSystem $subsumes operation not yet implemented'
      }]
    });
  }

  /**
   * Handle an instance-level $subsumes request
   * @param {express.Request} req - Express request (with txProvider attached)
   * @param {express.Response} res - Express response
   * @param {Object} log - Logger instance
   */
  static handleInstance(req, res, log) {
    const { id } = req.params;
    const provider = req.txProvider;
    const params = req.method === 'POST' ? req.body : req.query;

    log.debug(`CodeSystem/${id}/$subsumes with params:`, params);

    // TODO: Implement instance subsumes logic using provider
    res.status(501).json({
      resourceType: 'OperationOutcome',
      issue: [{
        severity: 'error',
        code: 'not-supported',
        diagnostics: 'CodeSystem $subsumes operation not yet implemented'
      }]
    });
  }
}

module.exports = SubsumesWorker;

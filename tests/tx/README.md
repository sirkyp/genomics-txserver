# TX Module Tests

Integration tests for the TX (Terminology) Module.

## Prerequisites

```bash
npm install --save-dev jest supertest
```

## Running Tests

```bash
# Run all TX tests
npx jest tests/tx

# Run specific test file
npx jest tests/tx/lookup.test.js

# Run with verbose output
npx jest tests/tx --verbose

# Run with coverage
npx jest tests/tx --coverage
```

## Test Files

- **setup.js** - Test configuration and Express app setup
- **tx-module.test.js** - Basic module initialization, metadata, CORS, request IDs
- **read.test.js** - `GET /CodeSystem/{id}` and `GET /ValueSet/{id}` operations
- **search.test.js** - Search operations with pagination, filtering, sorting
- **lookup.test.js** - `$lookup` operation with various parameter formats

## Test Data

Tests use the R5 core package which is automatically loaded when calling `cloneWithFhirVersion('5')`. This provides standard FHIR code systems and value sets like:

- `http://hl7.org/fhir/administrative-gender` (CodeSystem and ValueSet)
- `http://hl7.org/fhir/publication-status`
- And many others from the R5 specification

## Test Structure

Each test file follows this pattern:

```javascript
const request = require('supertest');
const { getTestApp, shutdownTestApp } = require('./setup');

describe('Worker Name', () => {
  let app;

  beforeAll(async () => {
    app = await getTestApp();
  }, 60000); // 60s timeout for initialization

  afterAll(async () => {
    await shutdownTestApp();
  });

  // Tests...
});
```

The `getTestApp()` function returns a shared Express app instance, so initialization only happens once across all test files when run together.

## Timeout Configuration

Library initialization can take time, so tests use a 60-second timeout in `beforeAll`. You may need to adjust Jest's default timeout:

```javascript
// In jest.config.js or package.json
{
  "testTimeout": 60000
}
```

## Notes

- Tests make actual HTTP requests to the Express app using supertest
- No mocking of the provider layer - uses real R5 core data
- Tests verify both success cases and error handling
- Request IDs are validated to ensure logging infrastructure works

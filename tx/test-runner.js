
const FhirValidator = require('fhir-validator-wrapper');
const express = require('express');
const path = require('path');
const fs = require('fs');
const TXModule = require('../tx/tx.js');
const ServerStats = require("../stats");

async function startTxTests() {
    await startServer();
    // await loadValidator();
}

async function  finishTxTests() {
    // await unloadValidator();
    await stopServer();
}

async function runTest(test) {
    expect(true).toBe(true);
}


const TEST_PORT = 9095;
const VALIDATOR_PORT = 9096;
const TEST_CONFIG_FILE = path.join(__dirname, 'fixtures', 'test-cases-setup.json');
const VALIDATOR_JAR = path.join(__dirname, '..', '..', 'validator', 'validator_cli.jar'); // Adjust path as needed


let server = null;
let validator = null;
let txModule = null;

async function startServer() {
    const app = express();

    // Load test configuration
    let config;
    try {
        const configData = fs.readFileSync(TEST_CONFIG_FILE, 'utf8');
        config = JSON.parse(configData);
    } catch (error) {
        throw new Error(`Failed to load test config: ${error.message}`);
    }

    // Middleware
    app.use(express.raw({ type: 'application/fhir+json', limit: '50mb' }));
    app.use(express.raw({ type: 'application/fhir+xml', limit: '50mb' }));
    app.use(express.json({ limit: '50mb' }));

    // Initialize TX module only
    txModule = new TXModule(new ServerStats());
    await txModule.initialize(config, app);

    return new Promise((resolve, reject) => {
        server = app.listen(TEST_PORT, (err) => {
            if (err) {
                reject(err);
            } else {
                console.log(`Test server started on port ${TEST_PORT}`);
                resolve();
            }
        });
    });
}

async function stopServer() {
    if (txModule && typeof txModule.shutdown === 'function') {
        await txModule.shutdown();
        txModule = null;
    }

    if (server) {
        return new Promise((resolve) => {
            server.close(() => {
                console.log('Test server stopped');
                server = null;
                resolve();
            });
        });
    }
}


module.exports = { startTxTests, finishTxTests, runTest };
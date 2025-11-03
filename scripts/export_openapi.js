#!/usr/bin/env node
/*
Export OpenAPI spec from AWS API Gateway (HTTP API v2 or REST API v1).

Auto-detects API type by trying HTTP API v2 first, then REST API v1.
Can also accept explicit API type via --api-type flag.

Usage:
  node scripts/export_openapi.js \
    --api-id <API_ID> \
    --stage <STAGE> \
    [--api-type http|rest] \
    [--output openapi.json] \
    [--region <REGION>]

If --api-type is not provided, auto-detection will:
  1. Try to get API as HTTP API v2
  2. If that fails, try REST API v1
  3. Export using the appropriate command

Output:
  Creates openapi.json (or specified output file) with OpenAPI 3.0 spec.
  Exits with code 0 on success, non-zero on error.
*/

const { execSync } = require('child_process');
const fs = require('fs');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith('--')) {
      const key = k.replace(/^--/, '');
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      args[key] = val;
    }
  }
  return args;
}

function execCommand(command, options = {}) {
  try {
    execSync(command, { 
      stdio: 'inherit',
      encoding: 'utf-8',
      ...options 
    });
    return { success: true };
  } catch (error) {
    return { 
      success: false, 
      error: error.message,
      stderr: error.stderr?.toString() || ''
    };
  }
}

function detectApiType(apiId) {
  console.log(`Detecting API type for ${apiId}...`);
  
  // Try HTTP API v2 first (most common)
  console.log('  Trying HTTP API (v2)...');
  const httpResult = execCommand(`aws apigatewayv2 get-api --api-id ${apiId}`, {
    stdio: 'pipe'
  });
  
  if (httpResult.success) {
    console.log('  ✓ Detected: HTTP API (v2)');
    return 'http';
  }
  
  // Try REST API v1
  console.log('  Trying REST API (v1)...');
  const restResult = execCommand(`aws apigateway get-rest-api --rest-api-id ${apiId}`, {
    stdio: 'pipe'
  });
  
  if (restResult.success) {
    console.log('  ✓ Detected: REST API (v1)');
    return 'rest';
  }
  
  // Neither worked
  console.error(`  ✗ Could not detect API type for ${apiId}`);
  console.error('    HTTP API v2 error:', httpResult.stderr || httpResult.error);
  console.error('    REST API v1 error:', restResult.stderr || restResult.error);
  return null;
}

function exportHttpApi(apiId, stage, outputFile) {
  console.log(`Exporting HTTP API (v2) ${apiId} from stage ${stage}...`);
  const command = `aws apigatewayv2 export-api \\
    --api-id ${apiId} \\
    --output-type JSON \\
    --specification OAS30 \\
    --stage-name ${stage} \\
    ${outputFile}`;
  
  const result = execCommand(command);
  if (!result.success) {
    console.error(`Failed to export HTTP API: ${result.error || result.stderr}`);
    return false;
  }
  
  console.log(`✓ Exported to ${outputFile}`);
  return true;
}

function exportRestApi(restApiId, stage, outputFile) {
  console.log(`Exporting REST API (v1) ${restApiId} from stage ${stage}...`);
  const command = `aws apigateway get-export \\
    --rest-api-id ${restApiId} \\
    --stage-name ${stage} \\
    --export-type oas30 \\
    --parameters extensions='postman' \\
    --accepts application/json \\
    ${outputFile}`;
  
  const result = execCommand(command);
  if (!result.success) {
    console.error(`Failed to export REST API: ${result.error || result.stderr}`);
    return false;
  }
  
  console.log(`✓ Exported to ${outputFile}`);
  return true;
}

(async () => {
  try {
    const args = parseArgs(process.argv);
    const apiId = args['api-id'] || args.apiId;
    const stage = args.stage;
    const apiType = args['api-type'] || args.apiType;
    const outputFile = args.output || args.o || 'openapi.json';

    if (!apiId || !stage) {
      console.error('Usage: node scripts/export_openapi.js --api-id <API_ID> --stage <STAGE> [--api-type http|rest] [--output openapi.json]');
      console.error('');
      console.error('Options:');
      console.error('  --api-id <ID>       API Gateway ID (required)');
      console.error('  --stage <STAGE>     Stage name (required)');
      console.error('  --api-type <TYPE>   Force API type: "http" or "rest" (optional, auto-detected if not provided)');
      console.error('  --output <FILE>     Output file path (default: openapi.json)');
      process.exit(2);
    }

    // Determine API type
    let detectedType = apiType?.toLowerCase();
    
    if (!detectedType) {
      detectedType = detectApiType(apiId);
      if (!detectedType) {
        console.error('');
        console.error('Could not auto-detect API type. Please specify --api-type http or --api-type rest');
        console.error('');
        console.error('To identify your API type manually:');
        console.error('  aws apigatewayv2 get-apis        # Check for HTTP APIs (v2)');
        console.error('  aws apigateway get-rest-apis      # Check for REST APIs (v1)');
        process.exit(1);
      }
    } else {
      detectedType = detectedType.toLowerCase();
      if (detectedType !== 'http' && detectedType !== 'rest') {
        console.error(`Invalid API type: ${detectedType}. Must be "http" or "rest"`);
        process.exit(2);
      }
      console.log(`Using specified API type: ${detectedType === 'http' ? 'HTTP API (v2)' : 'REST API (v1)'}`);
    }

    // Export based on type
    let success = false;
    if (detectedType === 'http') {
      success = exportHttpApi(apiId, stage, outputFile);
    } else {
      success = exportRestApi(apiId, stage, outputFile);
    }

    if (!success) {
      console.error('');
      console.error('Export failed. Troubleshooting:');
      console.error('  1. Verify API ID is correct');
      console.error('  2. Verify stage name is correct');
      console.error('  3. Try the other API type if auto-detection was used');
      console.error('  4. Ensure AWS credentials are configured');
      process.exit(1);
    }

    // Validate output
    if (fs.existsSync(outputFile)) {
      const stats = fs.statSync(outputFile);
      if (stats.size === 0) {
        console.error(`Warning: ${outputFile} is empty`);
        process.exit(1);
      }
      console.log(`✓ File size: ${(stats.size / 1024).toFixed(2)} KB`);
    } else {
      console.error(`Error: ${outputFile} was not created`);
      process.exit(1);
    }

  } catch (err) {
    console.error(err.stack || String(err));
    process.exit(1);
  }
})();


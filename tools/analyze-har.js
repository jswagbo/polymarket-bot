#!/usr/bin/env node
/**
 * HAR File Analyzer for Polymarket API Discovery
 * 
 * Usage: node analyze-har.js <path-to-har-file>
 * 
 * This script analyzes HAR files exported from browser dev tools
 * to find Polymarket API endpoints for Bitcoin Up/Down markets.
 */

const fs = require('fs');
const path = require('path');

function analyzeHar(harPath) {
  console.log('🔍 Analyzing HAR file:', harPath);
  console.log('');
  
  const harContent = fs.readFileSync(harPath, 'utf8');
  const har = JSON.parse(harContent);
  
  const entries = har.log.entries;
  console.log(`📊 Total requests captured: ${entries.length}`);
  console.log('');
  
  // Keywords to search for
  const keywords = ['btc', 'bitcoin', 'up', 'down', 'updown', 'token', 'clob', 'gamma', 'market', 'order'];
  
  const interestingRequests = [];
  const wsConnections = [];
  const apiEndpoints = new Set();
  
  for (const entry of entries) {
    const url = entry.request.url;
    const method = entry.request.method;
    const status = entry.response.status;
    
    // Check for WebSocket upgrades
    if (url.startsWith('wss://') || entry.request.headers.some(h => h.name.toLowerCase() === 'upgrade')) {
      wsConnections.push({ url, method });
      continue;
    }
    
    // Check URL for keywords
    const urlLower = url.toLowerCase();
    const matchedKeywords = keywords.filter(k => urlLower.includes(k));
    
    if (matchedKeywords.length > 0) {
      // Get response body if available
      let responseBody = '';
      try {
        if (entry.response.content && entry.response.content.text) {
          responseBody = entry.response.content.text;
        }
      } catch (e) {}
      
      interestingRequests.push({
        url,
        method,
        status,
        keywords: matchedKeywords,
        hasResponse: responseBody.length > 0,
        responsePreview: responseBody.substring(0, 200),
      });
      
      // Extract base API endpoint
      try {
        const urlObj = new URL(url);
        apiEndpoints.add(`${urlObj.protocol}//${urlObj.host}${urlObj.pathname.split('/').slice(0, 3).join('/')}`);
      } catch (e) {}
    }
  }
  
  // Report findings
  console.log('='.repeat(60));
  console.log('🌐 WEBSOCKET CONNECTIONS');
  console.log('='.repeat(60));
  if (wsConnections.length === 0) {
    console.log('None found');
  } else {
    wsConnections.forEach(ws => console.log(`  ${ws.url}`));
  }
  
  console.log('');
  console.log('='.repeat(60));
  console.log('🔗 API ENDPOINTS DISCOVERED');
  console.log('='.repeat(60));
  apiEndpoints.forEach(ep => console.log(`  ${ep}`));
  
  console.log('');
  console.log('='.repeat(60));
  console.log('📋 INTERESTING REQUESTS');
  console.log('='.repeat(60));
  
  interestingRequests.forEach((req, i) => {
    console.log(`\n[${i + 1}] ${req.method} ${req.url.substring(0, 100)}${req.url.length > 100 ? '...' : ''}`);
    console.log(`    Status: ${req.status} | Keywords: ${req.keywords.join(', ')}`);
    if (req.hasResponse && req.responsePreview) {
      console.log(`    Response: ${req.responsePreview.substring(0, 100)}...`);
    }
  });
  
  // Look specifically for token IDs and condition IDs
  console.log('');
  console.log('='.repeat(60));
  console.log('🎯 SEARCHING FOR MARKET DATA');
  console.log('='.repeat(60));
  
  for (const entry of entries) {
    try {
      if (entry.response.content && entry.response.content.text) {
        const text = entry.response.content.text;
        
        // Look for condition IDs (0x...)
        const conditionMatches = text.match(/0x[a-fA-F0-9]{64}/g);
        if (conditionMatches && conditionMatches.length > 0) {
          console.log(`\n📍 Found condition IDs in: ${entry.request.url.substring(0, 80)}`);
          console.log(`   IDs: ${conditionMatches.slice(0, 3).join(', ')}${conditionMatches.length > 3 ? '...' : ''}`);
        }
        
        // Look for "Up" and "Down" outcomes
        if (text.includes('"Up"') && text.includes('"Down"')) {
          console.log(`\n🎯 FOUND UP/DOWN MARKET DATA in: ${entry.request.url}`);
          console.log(`   Response preview: ${text.substring(0, 300)}...`);
        }
      }
    } catch (e) {}
  }
  
  console.log('');
  console.log('='.repeat(60));
  console.log('✅ Analysis complete!');
  console.log('='.repeat(60));
}

// Main
const args = process.argv.slice(2);
if (args.length === 0) {
  console.log('Usage: node analyze-har.js <path-to-har-file>');
  console.log('');
  console.log('Export a HAR file from browser dev tools:');
  console.log('1. Open https://polymarket.com/event/btc-updown-15m-...');
  console.log('2. Open Dev Tools (F12) → Network tab');
  console.log('3. Refresh the page');
  console.log('4. Right-click → Save all as HAR with content');
  process.exit(1);
}

analyzeHar(args[0]);



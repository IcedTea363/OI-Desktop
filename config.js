'use strict';
const { app } = require('electron');
const path    = require('path');
const fs      = require('fs');

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');

const DEFAULTS = {
  url:      '',
  appName:  'Open WebUI',
  firstRun: true,
  theme:    'system',   // 'system' | 'light' | 'dark'
  hotkey:   'CommandOrControl+Shift+Space',
};

let _cache = null;

function load() {
  if (_cache) return _cache;
  try { _cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) }; }
  catch { _cache = { ...DEFAULTS }; }
  return _cache;
}

function save(updates) {
  _cache = { ...load(), ...updates };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(_cache, null, 2));
  return _cache;
}

function get(key) { return load()[key]; }

module.exports = { load, save, get };

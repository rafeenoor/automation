// app.js — CRP workflow with modal-safe acks (push/update/errors) and no DMs
require('dotenv').config();
const express = require('express');
const { App, ExpressReceiver, LogLevel } = require('@slack/bolt');
const { Octokit } = require('@octokit/rest');

// ───────────────────────────────────────────────────────────────────────────────
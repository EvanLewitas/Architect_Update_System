const CIC = Object.freeze({
  TIME_ZONE: 'America/New_York',
  COMPANY_NAME: 'Center Island Contracting',
  OFFICE_EMAIL: 'office@centerislandcontracting.com',
  PROJECTS: 'PROJECTS',
  ARCHITECTS: 'ARCHITECTS',
  UPDATE_LOG: 'UPDATE LOG',
  OVERRIDES: 'MANUAL OVERRIDES',
  CONTROL: 'CONTROL',
  REPORT: 'CURRENT REPORT',
  CONFIG: 'CONFIG',
  HEADER_ROW: 4,
  FIRST_DATA_ROW: 5,
  REPORT_FIRST_ROW: 8,
  MAX_UPDATE_LENGTH: 5000,
  TOKEN_SECRET_KEY: 'CIC_ARCHITECT_TOKEN_SECRET',
  TOKEN_NONCE_PREFIX: 'CIC_ARCHITECT_NONCE_',
  TRIGGER_FUNCTIONS: ['sendMondayRequests', 'sendOverdueReminders', 'syncProjectsFromSource'],
});

const MILESTONE_HEADERS = Object.freeze([
  'Site Visit',
  'Prelims Received',
  'Prelims Approved',
  'CDs Received',
  'CDs Approved',
  'Application Sent to Building Department',
]);

const CLIENT_PROVIDED_PLAN_MILESTONES = Object.freeze([
  { header: 'CDs Approved', name: 'CDs Approved' },
  { header: 'Application Sent to Building Department', name: 'Plans Submitted' },
]);

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('CIC Architect Updates')
    .addItem('Refresh Current Report', 'refreshCurrentReport')
    .addItem('Refresh Control Dashboard', 'refreshControlDashboard')
    .addSeparator()
    .addItem('Run PRE-PRODUCTION Sync', 'syncProjectsFromSource')
    .addItem('Send Monday Requests', 'sendMondayRequests')
    .addItem('Send Overdue Reminders', 'sendOverdueReminders')
    .addSeparator()
    .addItem('Install or Repair System', 'installSystem')
    .addToUi();
}

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('CIC Architect Update Portal')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

function installSystem() {
  validateWorkbook_();
  SpreadsheetApp.getActive().setSpreadsheetTimeZone(CIC.TIME_ZONE);
  ensureConfigSheet_();
  ensureControlLayout_();
  ensureSystemSecret_();
  initializeArchitectLinks();
  installTriggers_();
  refreshCurrentReport();
  recordEvent_('INFO', 'INSTALL', 'System installation and validation completed.');
   SpreadsheetApp.getActive().toast(
    'Installation is complete. Fill in CONFIG, replace sample rows, deploy the web app, and test before turning Test Mode off.',
    'CIC Architect Update System',
    8
  );
  
}

function getPortalData(accessToken) {
  validateWorkbook_();
  const architect = findArchitectByToken_(accessToken);
  const projects = getActiveProjectsForArchitect_(architect['Architect Name']);
  const weekStart = getCurrentWeekStart_();
  const currentRows = getCurrentWeekRows_(architect['Architect Name'], weekStart);
  const latestRevision = maxRevision_(currentRows);
  const currentByClient = latestRowsByClient_(currentRows);
  const displayByClient = buildLatestDisplayMap_();
  const submittedClients = new Set(
    currentRows
      .filter(function (row) { return Number(row['Revision Number']) === latestRevision; })
      .map(function (row) { return normalize_(row['Client Name']); })
  );
  const fullSubmission = projects.length > 0 && projects.every(function (project) {
    return submittedClients.has(normalize_(project['Client Name']));
  });

  return {
    architectName: safeText_(architect['Architect Name']),
    primaryContactName: safeText_(architect['Primary Contact Name']),
    weekStart: dateKey_(weekStart),
    weekLabel: formatDate_(weekStart, 'MMMM d, yyyy'),
    deadlineLabel: 'Monday at 5:00 PM Eastern',
    currentRevision: latestRevision,
    submissionStatus: fullSubmission ? 'Revision ' + latestRevision + ' received' : 'Updates required',
    projects: projects.map(function (project) {
      return portalProject_(project, currentByClient[normalize_(project['Client Name'])], displayByClient[normalize_(project['Client Name'])]);
    }),
  };
}

function saveSubmission(accessToken, payload) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  let receipt;
  let officeNotice;

  try {
    validateWorkbook_();
    const architect = findArchitectByToken_(accessToken);
    const architectName = architect['Architect Name'];
    const primaryContactName = architect['Primary Contact Name'];
    const activeProjects = getActiveProjectsForArchitect_(architectName);
    const activeByClient = {};
    activeProjects.forEach(function (project) {
      activeByClient[normalize_(project['Client Name'])] = project;
    });

    const responses = validateResponses_(payload && payload.responses, activeByClient);
    const weekStart = getCurrentWeekStart_();
    const revision = maxRevision_(getCurrentWeekRows_(architectName, weekStart)) + 1;
    const submittedAt = new Date();
    const submissionId = Utilities.getUuid();
    const metadata = buildMetadata_(payload && payload.metadata);
    const displayByClient = buildLatestDisplayMap_();
    const logRows = [];
    let noChangeCount = 0;

    responses.forEach(function (response) {
      const clientName = activeByClient[response.clientKey]['Client Name'];
      const responseType = response.noChange ? 'No Change' : 'Written Update';
      const updateText = response.noChange ? '' : response.text;
      const documentsNeeded = response.documentsNeeded;
      let displayedText = updateText;
      let replacedOverrideIds = [];

      if (response.noChange) {
        const priorDisplay = displayByClient[normalize_(clientName)] || { text: '' };
        displayedText = priorDisplay.text;
        noChangeCount += 1;
      } else {
        replacedOverrideIds = replaceActiveOverrides_(clientName, submittedAt, submissionId);
      }

      logRows.push([
        submissionId,
        weekStart,
        submittedAt,
        revision,
        architectName,
        primaryContactName,
        clientName,
        responseType,
        updateText,
         documentsNeeded,
        displayedText,
        replacedOverrideIds.join(', '),
        metadata,
      ]);
    });

    appendLogRows_(logRows);
    refreshCurrentReport_();
    refreshControlDashboard_();
    recordEvent_('INFO', 'SUBMISSION', architectName + ' submitted revision ' + revision + ' for ' + logRows.length + ' projects.');

    receipt = {
      success: true,
      submissionId: submissionId,
      revision: revision,
      submittedAt: formatDate_(submittedAt, 'MMMM d, yyyy h:mm a') + ' Eastern',
      projectCount: logRows.length,
      noChangeCount: noChangeCount,
    };

    officeNotice = {
      architectName: architectName,
      submitterName: primaryContactName,
      submittedAt: submittedAt,
      revision: revision,
      projectCount: logRows.length,
      noChangeCount: noChangeCount,
      submissionId: submissionId,
    };
  } finally {
    lock.releaseLock();
  }

  try {
    sendOfficeSubmissionNotice_(officeNotice);
  } catch (error) {
    recordEvent_('ERROR', 'OFFICE NOTICE', error.message || String(error));
    receipt.notificationWarning = 'Updates were saved, but the internal notification email failed.';
  }

  return receipt;
}

function sendMondayRequests() {
  runArchitectEmailBatch_('REQUEST');
}

function sendOverdueReminders() {
  runArchitectEmailBatch_('REMINDER');
}

function runArchitectEmailBatch_(mode) {
  validateWorkbook_();
  const config = getConfig_();
  const architects = readRecords_(CIC.ARCHITECTS).filter(function (row) {
    return isYes_(row.Active) && safeText_(row['Primary Email']);
  });
  const weekStart = getCurrentWeekStart_();
  const sheet = getSheet_(CIC.ARCHITECTS);
  let sent = 0;

  architects.forEach(function (architect) {
    const architectName = architect['Architect Name'];
    const projects = getActiveProjectsForArchitect_(architectName);
    if (!projects.length) return;

    if (mode === 'REMINDER' && hasCompleteCurrentSubmission_(architectName, projects, weekStart)) return;

    const token = ensureArchitectToken_(architect);
    const portalUrl = buildPortalUrl_(token, config);
    const email = buildArchitectEmail_(mode, architect, projects.length, portalUrl, weekStart);
    const delivery = resolveDelivery_(architect, email, config);
    MailApp.sendEmail(delivery);

    const stampColumn = mode === 'REQUEST' ? headerColumn_(CIC.ARCHITECTS, 'Last Monday Email') : headerColumn_(CIC.ARCHITECTS, 'Last Reminder');
    sheet.getRange(architect._rowNumber, stampColumn).setValue(new Date());
    sent += 1;
    recordEvent_('INFO', mode + ' EMAIL', 'Sent to ' + delivery.to + ' for ' + architectName + '.');
  });

  refreshControlDashboard_();
  return { sent: sent, mode: mode };
}

function buildArchitectEmail_(mode, architect, projectCount, portalUrl, weekStart) {
  const isReminder = mode === 'REMINDER';
  const greetingName = safeText_(architect['Primary Contact Name']) || safeText_(architect['Architect Name']);
  const subject = isReminder
    ? 'Architect updates overdue, please complete as soon as possible'
    : 'Weekly project status updates requested by 5:00 PM today';
  const intro = isReminder
    ? "We have not received this week's status updates for the Center Island Contracting projects assigned to you. Please complete the page as soon as possible."
    : "Please use the link below to provide this week's status update for every active Center Island Contracting project assigned to you. The page includes our current milestone dates and the most recent update on file.";
  const deadline = isReminder ? '' : '<p style="margin:18px 0 0">Please submit all updates by 5:00 PM today. Select <strong>No change</strong> when there is no new information for a project.</p>';
  const htmlBody = [
    '<div style="font-family:Arial,sans-serif;color:#172a36;line-height:1.55;max-width:650px">',
    '<p>Good ' + (isReminder ? 'afternoon' : 'morning') + ' ' + htmlEscape_(greetingName) + ',</p>',
    '<p>' + htmlEscape_(intro) + '</p>',
    '<p style="margin:24px 0"><a href="' + htmlEscape_(portalUrl) + '" style="background:#14648d;color:#fff;text-decoration:none;padding:14px 22px;border-radius:7px;display:inline-block;font-weight:bold">OPEN PROJECT UPDATE PAGE</a></p>',
    '<p style="color:#61717b">' + projectCount + ' active ' + (projectCount === 1 ? 'project' : 'projects') + ' for the week of ' + htmlEscape_(formatDate_(weekStart, 'MMMM d, yyyy')) + '.</p>',
    deadline,
    '<p style="margin-top:26px">Thank you,<br>Center Island Contracting</p>',
    '</div>',
  ].join('');
  const body = [
    'Good ' + (isReminder ? 'afternoon' : 'morning') + ' ' + greetingName + ',',
    '',
    intro,
    '',
    portalUrl,
    '',
    projectCount + ' active ' + (projectCount === 1 ? 'project' : 'projects') + ' for the week of ' + formatDate_(weekStart, 'MMMM d, yyyy') + '.',
    isReminder ? '' : 'Please submit all updates by 5:00 PM today. Select No change when there is no new information for a project.',
    '',
    'Thank you,',
    'Center Island Contracting',
  ].join('\n');

  return { subject: subject, body: body, htmlBody: htmlBody };
}

function resolveDelivery_(architect, email, config) {
  const testMode = !/^no$/i.test(safeText_(config['Test Mode']));
  const testRecipient = safeText_(config['Test Recipient Email']);
  if (testMode && !testRecipient) {
    throw new Error('CONFIG is in Test Mode, but Test Recipient Email is blank.');
  }
  if (!testMode && /@example\.com$/i.test(safeText_(architect['Primary Email']))) {
    throw new Error('Live email blocked because an ARCHITECTS row still uses example.com.');
  }

  return {
    to: testMode ? testRecipient : safeText_(architect['Primary Email']),
    cc: testMode ? '' : safeText_(architect['CC Emails']),
    subject: (testMode ? '[TEST] ' : '') + email.subject,
    body: email.body,
    htmlBody: email.htmlBody,
    name: CIC.COMPANY_NAME,
    replyTo: CIC.OFFICE_EMAIL,
  };
}

function sendOfficeSubmissionNotice_(notice) {
  if (!notice) return;
  const config = getConfig_();
  const recipient = safeText_(config['Office Notification Email']) || CIC.OFFICE_EMAIL;
  const testMode = !/^no$/i.test(safeText_(config['Test Mode']));
  const testRecipient = safeText_(config['Test Recipient Email']);
  const to = testMode && testRecipient ? testRecipient : recipient;
  const subject = (testMode ? '[TEST] ' : '') + 'Architect updates received from ' + notice.architectName;
  const sheetUrl = SpreadsheetApp.getActive().getUrl();
  const body = [
    'Architect: ' + notice.architectName,
    'Submitter: ' + notice.submitterName,
    'Submitted: ' + formatDate_(notice.submittedAt, 'MMMM d, yyyy h:mm a') + ' Eastern',
    'Revision: ' + notice.revision,
    'Projects updated: ' + notice.projectCount,
    'No change responses: ' + notice.noChangeCount,
    'Submission ID: ' + notice.submissionId,
    '',
    'Open the update database:',
    sheetUrl,
  ].join('\n');
  MailApp.sendEmail({ to: to, subject: subject, body: body, name: CIC.COMPANY_NAME, replyTo: CIC.OFFICE_EMAIL });
}

function initializeArchitectLinks() {
  const records = readRecords_(CIC.ARCHITECTS).filter(function (row) {
    return safeText_(row['Architect Name']);
  });
  records.forEach(function (record) { ensureArchitectToken_(record); });
  return records.length;
}

function rotateArchitectLink(architectName) {
  const target = normalize_(architectName);
  const record = readRecords_(CIC.ARCHITECTS).find(function (row) {
    return normalize_(row['Architect Name']) === target;
  });
  if (!record) throw new Error('Architect not found: ' + architectName);
  const props = PropertiesService.getScriptProperties();
  props.setProperty(tokenNonceKey_(record['Architect Name']), Utilities.getUuid() + Utilities.getUuid());
  const token = ensureArchitectToken_(record, true);
  recordEvent_('INFO', 'TOKEN ROTATION', 'Private link rotated for ' + record['Architect Name'] + '.');
  return buildPortalUrl_(token, getConfig_());
}
function rotateBernardRodgersPilotLink() {
  const url = rotateArchitectLink('Bernard Rodgers');
  Logger.log(url);
  SpreadsheetApp.getActive().toast(
    'Bernard Rodgers pilot link rotated. Open Execution log to copy the URL.',
    'CIC Architect Updates',
    8
  );
  return url;
}
function ensureArchitectToken_(architect, forceWrite) {
  const secret = ensureSystemSecret_();
  const props = PropertiesService.getScriptProperties();
  const nonceKey = tokenNonceKey_(architect['Architect Name']);
  let nonce = props.getProperty(nonceKey);
  if (!nonce) {
    nonce = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty(nonceKey, nonce);
  }
  const bytes = Utilities.computeHmacSha256Signature(safeText_(architect['Architect Name']) + '|' + nonce, secret, Utilities.Charset.UTF_8);
  const token = Utilities.base64EncodeWebSafe(bytes).replace(/=+$/g, '');
  const tokenHash = hashHex_(token);
  if (forceWrite || safeText_(architect['Private Token Hash']) !== tokenHash) {
    const sheet = getSheet_(CIC.ARCHITECTS);
    sheet.getRange(architect._rowNumber, headerColumn_(CIC.ARCHITECTS, 'Private Token Hash')).setValue(tokenHash);
    sheet.getRange(architect._rowNumber, headerColumn_(CIC.ARCHITECTS, 'Token Created')).setValue(new Date());
    architect['Private Token Hash'] = tokenHash;
  }
  return token;
}

function ensureSystemSecret_() {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty(CIC.TOKEN_SECRET_KEY);
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid() + Utilities.getUuid();
    props.setProperty(CIC.TOKEN_SECRET_KEY, secret);
  }
  return secret;
}

function tokenNonceKey_(architectName) {
  return CIC.TOKEN_NONCE_PREFIX + hashHex_(normalize_(architectName)).slice(0, 24);
}

function findArchitectByToken_(accessToken) {
  const token = safeText_(accessToken);
  if (token.length < 32) throw new Error('This architect link is missing or invalid.');
  const tokenHash = hashHex_(token);
  const record = readRecords_(CIC.ARCHITECTS).find(function (row) {
    return isYes_(row.Active) && constantTimeEqual_(safeText_(row['Private Token Hash']), tokenHash);
  });
  if (!record) throw new Error('This architect link is invalid or has been replaced. Contact Center Island Contracting for a new link.');
  return record;
}

function buildPortalUrl_(token, config) {
  const override = safeText_(config['Portal URL Override']);
  const base = override || ScriptApp.getService().getUrl();
  if (!base) throw new Error('Deploy the Apps Script project as a web app before sending architect emails.');
  return base + (base.indexOf('?') === -1 ? '?' : '&') + 'access=' + encodeURIComponent(token);
}

function portalProject_(project, currentRow, displayValue) {
  const proposalAccepted = project['Proposal Accepted'];
  const display = displayValue || { text: '', date: '', submitter: '' };
  const milestones = milestoneDefinitionsForProject_(project).map(function (definition) {
    return {
      name: definition.name,
      date: dateKey_(project[definition.header]),
      dateLabel: formatDate_(project[definition.header], 'MMMM d, yyyy'),
    };
  });
  let nextFound = false;
  milestones.forEach(function (milestone) {
    milestone.complete = Boolean(milestone.date);
    milestone.next = !nextFound && !milestone.complete;
    if (milestone.next) nextFound = true;
  });

  return {
    clientName: safeText_(project['Client Name']),
    projectType: safeText_(project['Project Type']),
    town: safeText_(project.Town),
    proposalAccepted: dateKey_(proposalAccepted),
    proposalAcceptedLabel: formatDate_(proposalAccepted, 'MMMM d, yyyy'),
    daysSinceAcceptance: daysSince_(proposalAccepted),
    clientProvidedPlans: isClientProvidedPlans_(project),
    milestones: milestones,
    latestUpdateText: display.text,
    latestUpdateDate: dateKey_(display.date),
    latestUpdateDateLabel: formatDate_(display.date, 'MMMM d, yyyy'),
    latestUpdateSubmitter: display.submitter,
       currentResponseType: currentRow ? safeText_(currentRow['Response Type']) : '',
    currentUpdateText: currentRow && currentRow['Response Type'] === 'Written Update' ? safeText_(currentRow['Update Text']) : '',
    currentDocumentsNeeded: currentRow ? safeText_(currentRow['Documents Needed for Permit']) : '',
    currentSubmittedAt: currentRow ? formatDate_(currentRow['Submitted At'], 'MMMM d, yyyy h:mm a') + ' Eastern' : '',
    currentRevision: currentRow ? Number(currentRow['Revision Number']) || 0 : 0,
  };
}

function milestoneDefinitionsForProject_(project) {
  if (isClientProvidedPlans_(project)) return CLIENT_PROVIDED_PLAN_MILESTONES;
  return MILESTONE_HEADERS.map(function (header) {
    return { header: header, name: header };
  });
}

function isClientProvidedPlans_(project) {
  return isYes_(project['Client Provided Plans']) || normalize_(project['Assigned Architect']) === 'client provided';
}

function validateResponses_(input, activeByClient) {
  if (!Array.isArray(input)) throw new Error('No project responses were received.');
  const seen = {};
  const responses = input.map(function (item) {
    const clientKey = normalize_(item && item.clientName);
    if (!clientKey || !activeByClient[clientKey]) throw new Error('A submitted project is no longer assigned to this architect. Reload the page.');
    if (seen[clientKey]) throw new Error('Duplicate response received for ' + activeByClient[clientKey]['Client Name'] + '.');
    seen[clientKey] = true;
    const noChange = Boolean(item.noChange);
    const text = safeText_(item.updateText).trim();
    const documentsNeeded = safeText_(item.documentsNeeded).trim();
    if (noChange === Boolean(text)) throw new Error('Choose either No change or a written update for ' + activeByClient[clientKey]['Client Name'] + '.');
    if (text.length > CIC.MAX_UPDATE_LENGTH) throw new Error('The update for ' + activeByClient[clientKey]['Client Name'] + ' exceeds ' + CIC.MAX_UPDATE_LENGTH + ' characters.');
    if (documentsNeeded.length > CIC.MAX_UPDATE_LENGTH) throw new Error('The permit documents note for ' + activeByClient[clientKey]['Client Name'] + ' exceeds ' + CIC.MAX_UPDATE_LENGTH + ' characters.');
    return { clientKey: clientKey, noChange: noChange, text: text, documentsNeeded: documentsNeeded };
  });
  const activeKeys = Object.keys(activeByClient);
  if (responses.length !== activeKeys.length || activeKeys.some(function (key) { return !seen[key]; })) {
    throw new Error('Every active project must have a response. Reload the page and try again.');
  }
  return responses;
}

function appendLogRows_(rows) {
  if (!rows.length) return;
  const sheet = getSheet_(CIC.UPDATE_LOG);
  const startRow = firstEmptyRowInColumn_(sheet, 1, CIC.FIRST_DATA_ROW);
  const neededLastRow = startRow + rows.length - 1;
  if (neededLastRow > sheet.getMaxRows()) {
    sheet.insertRowsAfter(sheet.getMaxRows(), neededLastRow - sheet.getMaxRows() + 100);
  }

  sheet.getRange(startRow, 1, rows.length, rows[0].length).setValues(rows);
  sheet.getRange(startRow, 2, rows.length, 1).setNumberFormat('mmm d, yyyy');
  sheet.getRange(startRow, 3, rows.length, 1).setNumberFormat('mmm d, yyyy h:mm AM/PM');

  const lastFormulaRow = Math.max(sheet.getMaxRows(), neededLastRow, CIC.FIRST_DATA_ROW);
  const formulaRows = lastFormulaRow - CIC.FIRST_DATA_ROW + 1;
  const latestFormulas = [];
  const currentWeekFormulas = [];

  for (let row = CIC.FIRST_DATA_ROW; row <= lastFormulaRow; row += 1) {
    latestFormulas.push([
      '=IF(A' + row + '="","",D' + row + '=MAXIFS($D$5:$D$' + lastFormulaRow + ',$G$5:$G$' + lastFormulaRow + ',G' + row + ',$B$5:$B$' + lastFormulaRow + ',B' + row + '))'
    ]);
    currentWeekFormulas.push([
      '=IF(A' + row + '="","",B' + row + '=CONTROL!$B$5)'
    ]);
  }

  sheet.getRange(CIC.FIRST_DATA_ROW, 14, formulaRows, 1).setFormulas(latestFormulas);
  sheet.getRange(CIC.FIRST_DATA_ROW, 15, formulaRows, 1).setFormulas(currentWeekFormulas);
  SpreadsheetApp.flush();
}

function replaceActiveOverrides_(clientName, replacedAt, submissionId) {
  const sheet = getSheet_(CIC.OVERRIDES);
  const records = readRecords_(CIC.OVERRIDES).filter(function (row) {
    return normalize_(row['Client Name']) === normalize_(clientName) && isYes_(row.Active);
  });
  records.forEach(function (row) {
    sheet.getRange(row._rowNumber, headerColumn_(CIC.OVERRIDES, 'Active'), 1, 3)
      .setValues([['No', replacedAt, submissionId]]);
  });
  return records.map(function (row) { return safeText_(row['Override ID']); }).filter(Boolean);
}

function getLatestDisplayForClient_(clientName) {
  return buildLatestDisplayMap_()[normalize_(clientName)] || { text: '', date: '', submitter: '' };
}

function buildLatestDisplayMap_() {
  const result = {};
  readRecords_(CIC.UPDATE_LOG).forEach(function (row) {
    if (row['Response Type'] === 'Written Update' && safeText_(row['Update Text'])) {
      result[normalize_(row['Client Name'])] = {
        text: safeText_(row['Update Text']),
        date: row['Submitted At'],
        submitter: safeText_(row['Submitter Name']),
      };
    }
  });
  readRecords_(CIC.OVERRIDES).forEach(function (row) {
    if (isYes_(row.Active) && safeText_(row['Override Text'])) {
      result[normalize_(row['Client Name'])] = {
        text: safeText_(row['Override Text']),
        date: row['Entered At'],
        submitter: safeText_(row['Entered By']) || 'CIC Office',
      };
    }
  });
  return result;
}

function refreshCurrentReport() {
  validateWorkbook_();
  refreshCurrentReport_();
  refreshControlDashboard_();
SpreadsheetApp.getActive().toast('CURRENT REPORT refreshed.', 'CIC Architect Updates', 4);
}

function refreshCurrentReport_() {
  const projects = readRecords_(CIC.PROJECTS).filter(function (row) {
    return isYes_(row.Active) && safeText_(row['Client Name']);
  }).sort(function (a, b) {
    return safeText_(a['Assigned Architect']).localeCompare(safeText_(b['Assigned Architect'])) || safeText_(a['Client Name']).localeCompare(safeText_(b['Client Name']));
  });
  const weekStart = getCurrentWeekStart_();
  const currentRows = readRecords_(CIC.UPDATE_LOG).filter(function (row) { return sameDate_(row['Week Start'], weekStart); });
  const currentByClient = latestRowsByClient_(currentRows);
  const displayByClient = buildLatestDisplayMap_();
  const reportRows = projects.map(function (project, index) {
    const current = currentByClient[normalize_(project['Client Name'])];
    const display = displayByClient[normalize_(project['Client Name'])] || { text: '', date: '', submitter: '' };
    const responseType = current ? safeText_(current['Response Type']) : '';
    const status = !responseType ? 'OVERDUE' : responseType === 'No Change' ? 'COMPLETE - NO CHANGE' : 'COMPLETE - WRITTEN';
    return [
      project['Assigned Architect'], project['Client Name'], project['Project Type'], project.Town,
      project['Proposal Accepted'] || '', daysSince_(project['Proposal Accepted']),
      project['Site Visit'] || '', project['Prelims Received'] || '', project['Prelims Approved'] || '',
      project['CDs Received'] || '', project['CDs Approved'] || '', project['Application Sent to Building Department'] || '',
      display.text, display.date || '', display.submitter, responseType,
      current ? current['Submitted At'] : '', current ? Number(current['Revision Number']) || '' : '', status, index + 1,
    ];
  });
  const report = getSheet_(CIC.REPORT);
  const clearRows = Math.max(report.getMaxRows() - CIC.REPORT_FIRST_ROW + 1, 1);
  report.getRange(CIC.REPORT_FIRST_ROW, 1, clearRows, 20).clearContent();
  if (reportRows.length) {
    if (CIC.REPORT_FIRST_ROW + reportRows.length - 1 > report.getMaxRows()) {
      report.insertRowsAfter(report.getMaxRows(), CIC.REPORT_FIRST_ROW + reportRows.length - 1 - report.getMaxRows());
    }
    report.getRange(CIC.REPORT_FIRST_ROW, 1, reportRows.length, 20).setValues(reportRows);
  }
  const completed = reportRows.filter(function (row) { return /^COMPLETE/.test(row[18]); }).length;
  const overdue = reportRows.filter(function (row) { return row[18] === 'OVERDUE'; }).length;
  report.getRange('A5').setValue(reportRows.length);
  report.getRange('C5').setValue(completed);
  report.getRange('E5').setValue(overdue);
  report.getRange('G5').setValue(weekStart).setNumberFormat('mmm d, yyyy');
  if (reportRows.length) {
    report.getRange(CIC.REPORT_FIRST_ROW, 5, reportRows.length, 1).setNumberFormat('mmm d, yyyy');
    report.getRange(CIC.REPORT_FIRST_ROW, 7, reportRows.length, 6).setNumberFormat('mmm d, yyyy');
    report.getRange(CIC.REPORT_FIRST_ROW, 14, reportRows.length, 1).setNumberFormat('mmm d, yyyy h:mm AM/PM');
    report.getRange(CIC.REPORT_FIRST_ROW, 17, reportRows.length, 1).setNumberFormat('mmm d, yyyy h:mm AM/PM');
  }
  refreshProjectStatusColumns_(projects, currentByClient);
  SpreadsheetApp.flush();
}

function refreshProjectStatusColumns_(activeProjects, currentByClient) {
  const sheet = getSheet_(CIC.PROJECTS);
  const records = readRecords_(CIC.PROJECTS);
  if (!records.length) return;
  const values = records.map(function (project) {
    const current = currentByClient[normalize_(project['Client Name'])];
    const response = current ? safeText_(current['Response Type']) : '';
    const status = !isYes_(project.Active) ? 'INACTIVE' : !response ? 'OVERDUE' : response === 'No Change' ? 'COMPLETE - NO CHANGE' : 'COMPLETE - WRITTEN';
    return [response, current ? current['Submitted At'] : '', status];
  });
  sheet.getRange(CIC.FIRST_DATA_ROW, headerColumn_(CIC.PROJECTS, 'Current Week Response'), values.length, 3).setValues(values);
}

function refreshControlDashboard() {
  refreshControlDashboard_();
SpreadsheetApp.getActive().toast('CONTROL dashboard refreshed.', 'CIC Architect Updates', 4);;
}

function refreshControlDashboard_() {
  ensureControlLayout_();
  const control = getSheet_(CIC.CONTROL);
  const architects = readRecords_(CIC.ARCHITECTS).filter(function (row) { return isYes_(row.Active) && safeText_(row['Architect Name']); });
  const weekStart = getCurrentWeekStart_();
  const rows = architects.map(function (architect) {
    const projects = getActiveProjectsForArchitect_(architect['Architect Name']);
    const currentRows = getCurrentWeekRows_(architect['Architect Name'], weekStart);
    const revision = maxRevision_(currentRows);
    const latest = currentRows.slice().sort(function (a, b) { return dateNumber_(b['Submitted At']) - dateNumber_(a['Submitted At']); })[0];
    const complete = hasCompleteCurrentSubmission_(architect['Architect Name'], projects, weekStart);
    return [architect['Architect Name'], architect['Last Monday Email'] || '', architect['Last Reminder'] || '', complete ? 'COMPLETE' : 'OVERDUE', latest ? latest['Submitted At'] : '', revision || ''];
  });
  control.getRange('J5:O104').clearContent();
  if (rows.length) control.getRange(5, 10, rows.length, 6).setValues(rows);
  control.getRange('K5:L104').setNumberFormat('mmm d, yyyy h:mm AM/PM');
  control.getRange('N5:N104').setNumberFormat('mmm d, yyyy h:mm AM/PM');
}

function syncProjectsFromSource() {
  ensureConfigSheet_();
  const config = getConfig_();
  if (!isYes_(config['Source Sync Enabled'])) {
    recordEvent_('INFO', 'SOURCE SYNC', 'Skipped because Source Sync Enabled is not Yes.');
    return { skipped: true };
  }
  const sourceId = extractSpreadsheetId_(config['Source Spreadsheet ID']);
  const sourceTabName = safeText_(config['Source Tab Name']);
  const headerRow = Number(config['Source Header Row']) || 1;
  if (!sourceId || !sourceTabName) throw new Error('CONFIG requires Source Spreadsheet ID and Source Tab Name.');

  const source = SpreadsheetApp.openById(sourceId).getSheetByName(sourceTabName);
  if (!source) throw new Error('Source tab not found: ' + sourceTabName);
  const sourceValues = source.getDataRange().getValues();
  const headers = sourceValues[headerRow - 1].map(safeText_);
  const index = {};
  headers.forEach(function (header, i) { index[normalize_(header)] = i; });
  const clientIndex = requiredSourceIndex_(index, config['Source Client Name Header']);
  const architectIndex = requiredSourceIndex_(index, config['Source Assigned Architect Header']);
  const typeIndex = optionalSourceIndex_(index, config['Source Project Type Header']);
  const townIndex = optionalSourceIndex_(index, config['Source Town Header']);
  const destination = getSheet_(CIC.PROJECTS);
  const existing = readRecords_(CIC.PROJECTS);
  const existingByClient = {};
  existing.forEach(function (row) { if (safeText_(row['Client Name'])) existingByClient[normalize_(row['Client Name'])] = row; });
  const seen = {};
  const now = new Date();
  let added = 0;
  let updated = 0;

  sourceValues.slice(headerRow).forEach(function (row, offset) {
    const clientName = safeText_(row[clientIndex]).trim();
    if (!clientName) return;
    const key = normalize_(clientName);
    seen[key] = true;
    const values = [
      clientName,
      typeIndex === -1 ? '' : safeText_(row[typeIndex]),
      townIndex === -1 ? '' : safeText_(row[townIndex]),
      safeText_(row[architectIndex]),
      sourceId + '|' + sourceTabName + '|' + (headerRow + offset + 1),
      'Yes',
      now,
    ];
    const current = existingByClient[key];
    if (current) {
      destination.getRange(current._rowNumber, 1, 1, 7).setValues([values]);
      updated += 1;
    } else {
      const rowNumber = firstEmptyRowInColumn_(destination, 1, CIC.FIRST_DATA_ROW);
      const projectColumnCount = headerColumn_(CIC.PROJECTS, 'Current Status');
      const blanks = Array(Math.max(projectColumnCount - values.length, 0)).fill('');
      destination.getRange(rowNumber, 1, 1, projectColumnCount).setValues([values.concat(blanks)]);
      destination.getRange(rowNumber, 9).setFormula('=IF(H' + rowNumber + '="","",MAX(0,TODAY()-H' + rowNumber + '))');
      added += 1;
    }
  });

  existing.forEach(function (row) {
    const key = normalize_(row['Client Name']);
    if (key && !seen[key] && isYes_(row.Active)) destination.getRange(row._rowNumber, headerColumn_(CIC.PROJECTS, 'Active')).setValue('No');
  });
  getSheet_(CIC.CONTROL).getRange('B9').setValue(now);
  destination.getRange(CIC.FIRST_DATA_ROW, 1, Math.max(destination.getLastRow() - CIC.FIRST_DATA_ROW + 1, 1), headerColumn_(CIC.PROJECTS, 'Current Status')).sort([{ column: 4, ascending: true }, { column: 1, ascending: true }]);
  refreshCurrentReport_();
  refreshControlDashboard_();
  recordEvent_('INFO', 'SOURCE SYNC', 'Added ' + added + ', updated ' + updated + '.');
  return { added: added, updated: updated };
}

function installTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (CIC.TRIGGER_FUNCTIONS.indexOf(trigger.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('sendMondayRequests').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(8).nearMinute(0).create();
  ScriptApp.newTrigger('sendOverdueReminders').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(17).nearMinute(0).create();
  ScriptApp.newTrigger('syncProjectsFromSource').timeBased().everyDays(1).atHour(2).create();
  const config = getConfig_();
  if (isYes_(config['Source Sync Enabled']) && safeText_(config['Source Spreadsheet ID'])) {
    ScriptApp.newTrigger('syncProjectsFromSource')
      .forSpreadsheet(extractSpreadsheetId_(config['Source Spreadsheet ID']))
      .onEdit()
      .create();
  }
}

function hasCompleteCurrentSubmission_(architectName, projects, weekStart) {
  if (!projects.length) return true;
  const rows = getCurrentWeekRows_(architectName, weekStart);
  const revision = maxRevision_(rows);
  if (!revision) return false;
  const submitted = new Set(rows.filter(function (row) {
    return Number(row['Revision Number']) === revision;
  }).map(function (row) { return normalize_(row['Client Name']); }));
  return projects.every(function (project) { return submitted.has(normalize_(project['Client Name'])); });
}

function getCurrentWeekRows_(architectName, weekStart) {
  return readRecords_(CIC.UPDATE_LOG).filter(function (row) {
    return normalize_(row['Architect Name']) === normalize_(architectName) && sameDate_(row['Week Start'], weekStart);
  });
}

function latestRowsByClient_(rows) {
  const result = {};
  rows.forEach(function (row) { result[normalize_(row['Client Name'])] = row; });
  return result;
}

function maxRevision_(rows) {
  return rows.reduce(function (max, row) { return Math.max(max, Number(row['Revision Number']) || 0); }, 0);
}

function getActiveProjectsForArchitect_(architectName) {
  return readRecords_(CIC.PROJECTS).filter(function (row) {
    return isYes_(row.Active) && normalize_(row['Assigned Architect']) === normalize_(architectName) && safeText_(row['Client Name']);
  }).sort(function (a, b) { return safeText_(a['Client Name']).localeCompare(safeText_(b['Client Name'])); });
}

function getCurrentWeekStart_() {
  const control = getSheet_(CIC.CONTROL);
  const value = control.getRange('B5').getValue();
  if (value instanceof Date && !isNaN(value.getTime())) return value;
  const todayKey = Utilities.formatDate(new Date(), CIC.TIME_ZONE, 'yyyy-MM-dd');
  const parts = todayKey.split('-').map(Number);
  const utc = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() - day + 1);
  return utc;
}

function ensureConfigSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(CIC.CONFIG);
  if (!sheet) sheet = ss.insertSheet(CIC.CONFIG);
  const defaults = [
    ['Setting', 'Value', 'Instructions'],
    ['Test Mode', 'Yes', 'Keep Yes until every email and submission test passes.'],
    ['Test Recipient Email', '', 'All automated emails go here while Test Mode is Yes.'],
    ['Office Notification Email', CIC.OFFICE_EMAIL, 'Receives submission and revision notices in live mode.'],
    ['Portal URL Override', '', 'Usually blank. The deployed web-app URL is detected automatically.'],
    ['Source Sync Enabled', 'No', 'Set to Yes after the PRE-PRODUCTION mapping is complete.'],
    ['Source Spreadsheet ID', '', 'Paste the source spreadsheet URL or ID.'],
    ['Source Tab Name', 'PRE-PRODUCTION', 'Exact source tab name.'],
    ['Source Header Row', 1, 'Row containing the source column headings.'],
    ['Source Client Name Header', 'Client Name', 'Exact source heading.'],
    ['Source Assigned Architect Header', 'Architect', 'Exact source heading.'],
    ['Source Project Type Header', 'Project Type', 'Exact source heading or leave blank.'],
    ['Source Town Header', 'Town', 'Exact source heading or leave blank.'],
  ];
  if (!safeText_(sheet.getRange('A1').getValue())) {
    sheet.getRange(1, 1, defaults.length, 3).setValues(defaults);
    sheet.setFrozenRows(1);
    sheet.getRange('A1:C1').setBackground('#0b304b').setFontColor('#ffffff').setFontWeight('bold');
    sheet.getRange('B2:B13').setBackground('#fff5db');
    sheet.getRange('A:C').setWrap(true);
    sheet.setColumnWidth(1, 220);
    sheet.setColumnWidth(2, 330);
    sheet.setColumnWidth(3, 480);
    sheet.setTabColor('#14648d');
  }
  const yesNoRule = SpreadsheetApp.newDataValidation().requireValueInList(['Yes', 'No'], true).setAllowInvalid(false).build();
  sheet.getRange('B2').setDataValidation(yesNoRule);
  sheet.getRange('B6').setDataValidation(yesNoRule);
  return sheet;
}

function getConfig_() {
  const sheet = ensureConfigSheet_();
  const values = sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 1), 2).getValues();
  const config = {};
  values.forEach(function (row) { if (safeText_(row[0])) config[safeText_(row[0])] = row[1]; });
  return config;
}

function ensureControlLayout_() {
  const sheet = getSheet_(CIC.CONTROL);
  sheet.getRange('J1:O1').breakApart().merge().setValue('ARCHITECT EMAIL AND RESPONSE STATUS').setBackground('#e9f4fa').setFontColor('#082236').setFontWeight('bold');
  sheet.getRange('J4:O4').setValues([['Architect', 'Monday Email', 'Reminder', 'Current Week Status', 'Last Revision', 'Revision #']]).setBackground('#14648d').setFontColor('#ffffff').setFontWeight('bold');
  sheet.getRange('J13:M13').breakApart().merge().setValue('SYSTEM EVENT LOG').setBackground('#e9f4fa').setFontColor('#082236').setFontWeight('bold');
  sheet.getRange('J15:M15').setValues([['Event Time', 'Level', 'Action', 'Details']]).setBackground('#14648d').setFontColor('#ffffff').setFontWeight('bold');
  sheet.getRange('A12:H12').breakApart().merge().setValue('Use the CIC Architect Updates menu to refresh the report, run synchronization, and send email batches.').setBackground('#fff5db').setFontColor('#8b5d0a').setFontWeight('bold');
  sheet.setColumnWidth(10, 210);
  sheet.setColumnWidths(11, 5, 170);
}

function recordEvent_(level, action, details) {
  try {
    ensureControlLayout_();
    const sheet = getSheet_(CIC.CONTROL);
    const row = firstEmptyRowInColumn_(sheet, 10, 16);
    sheet.getRange(row, 10, 1, 4).setValues([[new Date(), level, action, safeText_(details).slice(0, 1000)]]);
    sheet.getRange(row, 10).setNumberFormat('mmm d, yyyy h:mm AM/PM');
  } catch (ignored) {}
}

function validateWorkbook_() {
  const required = {};
  required[CIC.PROJECTS] = ['Client Name', 'Project Type', 'Town', 'Assigned Architect', 'Active', 'Proposal Accepted'].concat(MILESTONE_HEADERS);
  required[CIC.ARCHITECTS] = ['Architect Name', 'Primary Contact Name', 'Primary Email', 'CC Emails', 'Active', 'Private Token Hash', 'Token Created', 'Last Monday Email', 'Last Reminder'];
  required[CIC.UPDATE_LOG] = ['Submission ID', 'Week Start', 'Submitted At', 'Revision Number', 'Architect Name', 'Submitter Name', 'Client Name', 'Response Type', 'Update Text', 'Documents Needed for Permit', 'Display Update After Submission'];
  required[CIC.OVERRIDES] = ['Override ID', 'Client Name', 'Override Text', 'Entered At', 'Entered By', 'Active', 'Replaced At', 'Replaced By Submission ID'];
  required[CIC.CONTROL] = ['SETTING', 'VALUE'];
  required[CIC.REPORT] = ['Architect', 'Client Name', 'Project Type', 'Town', 'Status'];
  Object.keys(required).forEach(function (sheetName) {
    const sheet = getSheet_(sheetName);
    const headerRow = sheetName === CIC.REPORT ? 7 : CIC.HEADER_ROW;
    const headers = sheet.getRange(headerRow, 1, 1, Math.max(sheet.getLastColumn(), 1)).getDisplayValues()[0].map(safeText_);
    required[sheetName].forEach(function (header) {
      if (headers.indexOf(header) === -1) throw new Error(sheetName + ' is missing required column: ' + header);
    });
  });
}

function readRecords_(sheetName) {
  const sheet = getSheet_(sheetName);
  const lastColumn = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet.getRange(CIC.HEADER_ROW, 1, 1, lastColumn).getDisplayValues()[0].map(safeText_);
  const lastRow = sheet.getLastRow();
  if (lastRow < CIC.FIRST_DATA_ROW) return [];
  const values = sheet.getRange(CIC.FIRST_DATA_ROW, 1, lastRow - CIC.FIRST_DATA_ROW + 1, lastColumn).getValues();
  return values.map(function (row, index) {
    const record = { _rowNumber: CIC.FIRST_DATA_ROW + index };
    headers.forEach(function (header, column) { if (header) record[header] = row[column]; });
    return record;
  }).filter(function (record) {
    return headers.some(function (header) { return header && safeText_(record[header]); });
  });
}

function headerColumn_(sheetName, headerName) {
  const sheet = getSheet_(sheetName);
  const headers = sheet.getRange(CIC.HEADER_ROW, 1, 1, Math.max(sheet.getLastColumn(), 1)).getDisplayValues()[0].map(safeText_);
  const index = headers.indexOf(headerName);
  if (index === -1) throw new Error(sheetName + ' is missing required column: ' + headerName);
  return index + 1;
}

function getSheet_(name) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sheet) throw new Error('Required sheet not found: ' + name);
  return sheet;
}

function firstEmptyRowInColumn_(sheet, column, minimumRow) {
  const lastRow = Math.max(sheet.getLastRow(), minimumRow - 1);
  if (lastRow < minimumRow) return minimumRow;
  const values = sheet.getRange(minimumRow, column, lastRow - minimumRow + 1, 1).getDisplayValues();
  for (let i = 0; i < values.length; i += 1) if (!safeText_(values[i][0])) return minimumRow + i;
  return lastRow + 1;
}

function buildMetadata_(metadata) {
  const safe = {
    source: 'architect-web-app',
    browserTimeZone: safeText_(metadata && metadata.browserTimeZone).slice(0, 100),
    screen: safeText_(metadata && metadata.screen).slice(0, 50),
  };
  return JSON.stringify(safe);
}

function extractSpreadsheetId_(value) {
  const text = safeText_(value);
  const match = text.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : text;
}

function requiredSourceIndex_(index, headerName) {
  const key = normalize_(headerName);
  if (!key || index[key] === undefined) throw new Error('Source column not found: ' + headerName);
  return index[key];
}

function optionalSourceIndex_(index, headerName) {
  const key = normalize_(headerName);
  return !key || index[key] === undefined ? -1 : index[key];
}

function daysSince_(value) {
  if (!(value instanceof Date) || isNaN(value.getTime())) return '';
  const today = dateKey_(new Date());
  const accepted = dateKey_(value);
  const todayUtc = Date.parse(today + 'T00:00:00Z');
  const acceptedUtc = Date.parse(accepted + 'T00:00:00Z');
  return Math.max(0, Math.floor((todayUtc - acceptedUtc) / 86400000));
}

function dateKey_(value) {
  if (!(value instanceof Date) || isNaN(value.getTime())) return '';
  return Utilities.formatDate(value, CIC.TIME_ZONE, 'yyyy-MM-dd');
}

function formatDate_(value, pattern) {
  if (!(value instanceof Date) || isNaN(value.getTime())) return '';
  return Utilities.formatDate(value, CIC.TIME_ZONE, pattern);
}

function sameDate_(left, right) {
  return Boolean(dateKey_(left)) && dateKey_(left) === dateKey_(right);
}

function dateNumber_(value) {
  return value instanceof Date && !isNaN(value.getTime()) ? value.getTime() : 0;
}

function normalize_(value) {
  return safeText_(value).trim().toLowerCase();
}

function safeText_(value) {
  return value === null || value === undefined ? '' : String(value);
}

function isYes_(value) {
  return /^(yes|true|1)$/i.test(safeText_(value).trim());
}

function htmlEscape_(value) {
  return safeText_(value).replace(/[&<>"']/g, function (character) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
  });
}

function hashHex_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, safeText_(value), Utilities.Charset.UTF_8)
    .map(function (byte) { const unsigned = byte < 0 ? byte + 256 : byte; return ('0' + unsigned.toString(16)).slice(-2); })
    .join('');
}

function constantTimeEqual_(left, right) {
  const a = safeText_(left);
  const b = safeText_(right);
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

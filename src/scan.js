const vm = require('vm');
const fs = require('fs');
const axios = require('axios');
const yargs = require('yargs');
const querystring = require('querystring');
const nodemailer = require('nodemailer');
const winston = require('winston');
const { format } = require('logform');
const Vue = require('vue');
const VueRenderer = require('vue-server-renderer').createRenderer();

let Logger = winston.createLogger({
  level: 'debug',
  format: format.combine(
    format.colorize(),
    format.timestamp(),
    format.align(),
    format.printf(info => `${info.timestamp} ${info.level}: ${info.message}`)
  ),
  transports: [new winston.transports.Console()]
});

async function all(...promises) {
  return await Promise.all(promises);
}

async function sleep(milliseconds) {
  return await new Promise((resolve, reject) => {
    setTimeout(resolve, milliseconds);
  });
}

function invert(obj) {
  let inverted = {};
  for (let key in obj) {
    let value = obj[key];
    inverted[value] = key;
  }
  return inverted;
}

async function jsonpExtensionThreads(extensionId) {
  const req = {
    appId: 94,
    version: '150922',
    hl: 'en',
    specs: [
      {
        type: 'CommentThread',
        url: `http://chrome.google.com/extensions/permalink?id=${extensionId}`,
        groups: 'chrome_webstore',
        sortby: 'date',
        startindex: '0',
        numresults: '25',
        id: '0' // Top-level response key.
      },
      {
        type: 'CommentThread',
        url: `http://chrome.google.com/extensions/permalink?id=${extensionId}`,
        groups: 'chrome_webstore_support',
        sortby: 'date',
        startindex: '0',
        numresults: '25',
        id: '1' // Top-level response key.
      }
    ],
    internedKeys: [],
    internedValues: []
  };

  Logger.info(`Fetch threads for ${extensionId}.`);

  let resp = await axios({
    url: 'https://chrome.google.com/reviews/components',
    method: 'post',
    headers: {
      'Content-Type': 'text/plain;charset=UTF-8',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_12_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/61.0.3163.100 Safari/537.36'
    },
    data: `req=${JSON.stringify(req)}`
  });

  if (resp.status !== 200) {
    throw new Error(`Unexpected HTTP response status: ${resp.status}.`);
  }

  return resp.data;
}

function loadJsonp(source) {
  // Replace the JSONP method call with a simple load(...) call.
  const jsonp = source.replace(/^.*?\(/, 'load(');

  const sandbox = {
    result: null,
    load: function () { return arguments; }
  };

  // Evaluate the JSONP in a sandbox and extract the result.
  vm.runInNewContext(`result=${jsonp}`, sandbox);
  return sandbox.result;
}

function authorFromAnnotation(annotation) {
  let entity = annotation.entity;
  return {
    name: entity.displayName,
    url: entity.profileUrl,
    image: entity.authorPhotoUrl
  };
}

function reviewFromAnnotation(annotation) {
  return {
    author: authorFromAnnotation(annotation),
    comment: annotation.comment,
    rating: annotation.starRating,
    createdAt: annotation.creationTimestamp
  };
}

function issueFromAnnotation(annotation) {
  return {
    author: authorFromAnnotation(annotation),
    title: annotation.title,
    comment: annotation.comment,
    type: (annotation.attributes.sfrAttributes.issueType || '').toLowerCase(),
    createdAt: annotation.timestamp
  };
}

async function fetchExtensionThreads(extensionId) {
  let jsonp = await jsonpExtensionThreads(extensionId);
  let [threads] = loadJsonp(jsonp);

  let reviews = threads[0].results.annotations.map(reviewFromAnnotation);
  let issues = threads[1].results.annotations.map(issueFromAnnotation);

  return { reviews, issues };
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    fs.readFile(file, 'utf8', (err, data) => {
      err ? reject(err) : resolve(data);
    });
  });
}

function writeFile(file, data) {
  return new Promise((resolve, reject) => {
    fs.writeFile(file, data, err => {
      err ? reject(err) : resolve();
    });
  });
}

async function loadJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file));
  } catch (e) {
    if (fallback) {
      return fallback;
    } else {
      throw e;
    }
  }
}

async function saveJson(obj, file) {
  let data = JSON.stringify(obj, null, '  ');
  await writeFile(file, data);
}

async function fetchNewPosts(extensionId, frontier) {
  let { reviews, issues } = await fetchExtensionThreads(extensionId);

  let reviewsFrontier = frontier.reviews || 0;
  let issuesFrontier = frontier.issues || 0;

  let newReviews = reviews
    .filter(r => r.createdAt > reviewsFrontier)
    .sort((p, q) => p.createdAt - q.createdAt);

  let newIssues = issues
    .filter(i => i.createdAt > issuesFrontier)
    .sort((p, q) => p.createdAt - q.createdAt);

  return {
    reviews: newReviews,
    issues: newIssues
  };
}

async function render(template, data) {
  const app = new Vue({
    template: `<div>${template}</div>`,
    data: data
  });

  let rendered = await VueRenderer.renderToString(app);
  return rendered.replace(/<div.*?>(.*)<\/div>/, '$1');
}

async function sendEmail(transport, template, data) {
  // Avoid sending emails too quickly.
  await sleep(0.5 * 1000);
  await new Promise(async (resolve, reject) => {
    transport.sendMail({
      from: template.from,
      to: template.to,
      subject: await render(template.subject, data),
      html: await render(template.body, data)
    }, (err, info) => {
      err ? reject(err) : resolve(info);
    });
  });
}

async function sendReviewEmail(transport, review, templates) {
  Logger.info('Send review email.');
  let template = { ...(templates.default || {}), ...(templates.reviews || {}) };
  await sendEmail(transport, template, review);
}

async function sendIssueEmail(transport, issue, templates) {
  Logger.info('Send issue email.');
  let template = { ...(templates.default || {}), ...(templates.issues || {}) };
  await sendEmail(transport, template, issue);
}

async function scan(config, frontiers, frontierFile) {
  const extensions = invert(config.extensions);
  const transport = nodemailer.createTransport(config.email);

  for (let id in extensions) {
    const extension = {
      id: id,
      name: extensions[id]
    };

    Logger.info(`Scan ${extension.name} (${id}).`);

    const hasFrontier = !!frontiers[id];
    if (!hasFrontier) {
      Logger.info('Skipping emails: first scan for this extension.');
      frontiers[id] = { reviews: 0, issues: 0 };
    }

    const { reviews, issues } = await fetchNewPosts(id, frontiers[id]);

    Logger.info(`Found ${reviews.length} new reviews.`);
    for (let review of reviews) {
      if (hasFrontier) {
        await sendReviewEmail(transport, { ...review, extension }, config.templates);
      }

      frontiers[id].reviews = review.createdAt;
      await saveJson(frontiers, frontierFile);
    }

    Logger.info(`Found ${issues.length} new issues.`);
    for (let issue of issues) {
      if (hasFrontier) {
        await sendIssueEmail(transport, { ...issue, extension }, config.templates);
      }

      frontiers[id].issues = issue.createdAt;
      await saveJson(frontiers, frontierFile);
    }
  }
}

async function run(args) {
  if (!args.config) {
    Logger.error('Config file not specified via --config <file>.');
    return;
  }

  if (!args.frontier) {
    Logger.error('Frontier file not specified via --frontier <file>.');
    return;
  }

  Logger.info('Load config and frontier.');
  let [config, frontiers] = await all(loadJson(args.config), loadJson(args.frontier, {}));

  Logger.info('Scan all extensions.');
  await scan(config, frontiers, args.frontier);
}

(async () => {
  try {
    await run(yargs.argv);
  } catch (e) {
    Logger.error(e);
    throw e;
  }
})();

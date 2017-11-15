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

async function jsonpExtensionThread(extensionId, group) {
  const req = {
    appId: 94,
    version: '150922',
    hl: 'en',
    specs: [
      {
        type: 'CommentThread',
        url: `http://chrome.google.com/extensions/permalink?id=${extensionId}`,
        groups: group,
        sortby: 'date',
        startindex: '0',
        numresults: '25',
        id: '0'
      }
    ],
    internedKeys: [],
    internedValues: []
  };

  Logger.info(`Fetch ${group} thread for ${extensionId}.`);

  let postBody = querystring.stringify({ req: JSON.stringify(req) });
  let resp = await axios.post('https://chrome.google.com/reviews/components', postBody);

  return resp.data;
}

async function fetchExtensionThread(extensionId, group) {
  let jsonp = await jsonpExtensionThread(extensionId, group);

  const sandbox = {
    result: null,
    window: {
      google: {
        annotations2: {
          component: {
            load: response => response
          }
        }
      }
    }
  };

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

async function fetchIssues(extensionId) {
  let issues = await fetchExtensionThread(extensionId, 'chrome_webstore_support');
  return issues[0].results.annotations.map(issueFromAnnotation);
}

async function fetchReviews(extensionId) {
  let reviews = await fetchExtensionThread(extensionId, 'chrome_webstore')
  return reviews[0].results.annotations.map(reviewFromAnnotation);
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
  let [reviews, issues] = await all(fetchReviews(extensionId), fetchIssues(extensionId));

  let reviewsFrontier = frontier.reviews || 0;
  let issuesFrontier = frontier.issues || 0;

  let newReviews = reviews.filter(r => r.createdAt > reviewsFrontier);
  let newIssues = issues.filter(i => i.createdAt > issuesFrontier);

  return {
    reviews: newReviews,
    issues: newIssues,
    frontier: {
      reviews: Math.max(reviewsFrontier, ...newReviews.map(r => r.createdAt)),
      issues: Math.max(issuesFrontier, ...newIssues.map(i => i.createdAt))
    }
  };
}

async function fetchAllNewPosts(config, allFrontiers) {
  let all = {};

  for (let id of config.extensions) {
    let extensionFrontier = allFrontiers[id] || {};
    all[id] = await fetchNewPosts(id, extensionFrontier);
  }

  return all;
}

async function template(template, data) {
  const app = new Vue({
    template: `<div>${template}</div>`,
    data: data
  });

  let rendered = await VueRenderer.renderToString(app);
  return rendered.replace(/<div.*?>(.*)<\/div>/, '$1');
}

async function sendEmail(config, templates, data) {
  // Avoid sending emails too quickly.
  await sleep(1 * 1000);

  let transporter = nodemailer.createTransport(config);
  await new Promise(async (resolve, reject) => {
    transporter.sendMail({
      from: config.from,
      to: config.to,
      subject: await template(templates.subject, data),
      html: await template(templates.body, data)
    }, (err, info) => {
      err ? reject(err) : resolve(info);
    });
  });
}

async function sendReviewEmail(review, config) {
  Logger.info('Send review email.');
  await sendEmail(config, config.reviews, review);
}

async function sendIssueEmail(issue, config) {
  Logger.info('Send issue email.');
  await sendEmail(config, config.issues, issue);
}

async function scan(config, frontier) {
  let newPosts = await fetchAllNewPosts(config, frontier);
  let newFrontier = {};

  for (let id in newPosts) {
    let posts = newPosts[id];
    newFrontier[id] = posts.frontier;

    Logger.info(`Found ${posts.reviews.length} new reviews.`);
    for (let review of posts.reviews) {
      await sendReviewEmail({ ...review, extensionId: id }, config.email);
    }

    Logger.info(`Found ${posts.issues.length} new issues.`);
    for (let issue of posts.issues) {
      await sendIssueEmail({ ...issue, extensionId: id }, config.email);
    }
  }

  return newFrontier;
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
  let [config, frontier] = await all(loadJson(args.config), loadJson(args.frontier, {}));

  Logger.info('Scan.');
  frontier = await scan(config, frontier);

  Logger.info('Save frontier.');
  await saveJson(frontier, args.frontier);
}

(async () => {
  try {
    await run(yargs.argv);
  } catch (e) {
    Logger.error(e);
    throw e;
  }
})();

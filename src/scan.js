const vm = require('vm');
const fs = require('fs');
const axios = require('axios');
const querystring = require('querystring');
const nodemailer = require('nodemailer');
const Vue = require('vue');
const VueRenderer = require('vue-server-renderer').createRenderer();

async function all(...promises) {
  return await Promise.all(promises);
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

async function loadConfig() {
  return JSON.parse(await readFile('config.json'));
}

async function loadFrontier() {
  try {
    return JSON.parse(await readFile('frontier.json'));
  } catch (e) {
    return {};
  }
}

async function saveFrontier(frontier) {
  let data = JSON.stringify(frontier, null, '  ');
  await writeFile('frontier.json', data);
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
  await sendEmail(config, config.reviews, review);
}

async function sendIssueEmail(issue, config) {
  await sendEmail(config, config.issues, issue);
}

async function run() {
  let [config, frontier] = await all(loadConfig(), loadFrontier());

  let newPosts = await fetchAllNewPosts(config, frontier);
  let newFrontier = {};

  for (let id in newPosts) {
    let posts = newPosts[id];
    newFrontier[id] = posts.frontier;

    for (let review of posts.reviews) {
      review.extensionId = id;
      await sendReviewEmail(review, config.email);
    }

    for (let issue of posts.issues) {
      issue.extensionId = id;
      await sendIssueEmail(issue, config.email);
    }
  }

  saveFrontier(newFrontier);
}

(async () => await run())();

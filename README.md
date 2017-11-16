# Chrome Extension Alerts

Get email notifications for user feedback on your Chrome extension.

## Running

You can [choose a stable tag](https://hub.docker.com/r/schmich/chrome-extension-alerts/tags) to use in place of `latest` below.

```bash
mkdir /srv/chrome-extension-alerts && cd /srv/chrome-extension-alerts
curl -LO https://raw.githubusercontent.com/schmich/chrome-extension-alerts/master/config.json
# Edit config.json with your configuration.
docker run --name chrome-extension-alerts -d -v `pwd`:/var/chrome-extension-alerts --restart always schmich/chrome-extension-alerts:latest
```

Reviews and issues are checked every ten minutes.

## Configuration

See [config.json](config.json).

- `extensions`: Dictionary of Chrome extensions to track. Maps extension names to IDs.
- `email`: Email configuration as defined by [Nodemailer](https://nodemailer.com/smtp/#examples).
- `template`: Email templates. `reviews` and `issues` inherit default values from `default`.

### Email Templates
  
Email `subject` and `body` are templates that are rendered using [Vue.js](https://vuejs.org/v2/guide/) with
review/issue instance data.

Example data available for review templates:

```js
{
  extension: {
    id: "lojgmehidjdhhbmpjfamhpkpodfcodef",
    name: "Marinara"
  },
  author: {
    name: "Chris Schmich",
    url: "https://plus.google.com/+ChrisSchmich0",
    image: "https://plus.google.com/_/focus/photos/public/AIbEiAIAAABECJTg4ZSDhd6ChAEiC3ZjYXJkX3Bob3RvKigxYmQwMTU4MjQ4MTk4OTZiZGM1NjUxZmE5ZGU0NjRjZmQyOWY0NjgzMAGi6j2eTVQ-Fb3Qj5Y9xrrvQhcxcQ"
  },
  comment: "This is a perfectly cromulent extension. 5/5 would install again.",
  rating: 5,
  createdAt: 1510696418,
}
```

Example data available for issue templates:

```js
{
  extension: {
    id: "lojgmehidjdhhbmpjfamhpkpodfcodef",
    name: "Marinara"
  },
  author: {
    name: "Chris Schmich",
    url: "https://plus.google.com/+ChrisSchmich0",
    image: "https://plus.google.com/_/focus/photos/public/AIbEiAIAAABECJTg4ZSDhd6ChAEiC3ZjYXJkX3Bob3RvKigxYmQwMTU4MjQ4MTk4OTZiZGM1NjUxZmE5ZGU0NjRjZmQyOWY0NjgzMAGi6j2eTVQ-Fb3Qj5Y9xrrvQhcxcQ"
  },
  title: "Keyboard is on fire."
  comment: "I installed this extension and now my keyboard is on firwzlkw-",
  type: "bug",
  createdAt: 1510697311
}
```

Possible issue `type` values are `question` (Questions), `feature` (Suggestions), and `bug` (Problems).

`createdAt` is when the item was created and is measured by the number of seconds since the epoch.
It can be formatted with `new Date(createdAt * 1000)`.

## License

Copyright &copy; 2017 Chris Schmich  
MIT License. See [LICENSE](LICENSE) for details.

require 'json'
require 'uri'
require 'excon'
require 'childprocess'
require 'addressable/template'

def fetch_extension_comments(extension_id)
  template = Addressable::Template.new('http://chrome.google.com/extensions/permalink{?id}')

  request = {
    appId: 94,
    version: '150922',
    hl: 'en',
    specs: [
      {
        type: 'CommentThread',
        url: template.expand({ id: extension_id }),
        groups: 'chrome_webstore',
        sortby: 'date',
        startindex: '0',
        numresults: '25',
        id: '234'
      }
    ],
    internedKeys: [],
    internedValues: []
  }

  resp = Excon.post('https://chrome.google.com/reviews/components',
    idempotent: true,
    retry_limit: 5,
    retry_interval: 5,
    body: URI.encode_www_form({ req: JSON.dump(request) }),
    headers: {
      'Content-Type' => 'application/x-www-form-urlencoded'
    }
  )

  javascript = <<SRC
    const window = {
      google: {
        annotations2: {
          component: {
            load: function(response) {
              console.log(JSON.stringify(response));
            }
          }
        }
      }
    };
SRC

  source = "#{javascript}\n#{resp.body}"

  stdout_rd, stdout_wr = IO.pipe
  process = ChildProcess.build('node')
  process.duplex = true
  process.io.stdout = process.io.stderr = stdout_wr
  process.start
  process.io.stdin.puts(source)
  process.io.stdin.close
  process.wait
  stdout_wr.close

  JSON.parse(stdout_rd.read)
end

require 'extension'
require 'date'

class Review < Struct.new(:author, :comment, :rating, :created_at)
end

class Issue < Struct.new(:author, :title, :comment, :type, :created_at)
end

class Author < Struct.new(:name, :url, :image)
  def self.from_annotation(annotation)
    entity = annotation['entity']
    Author.new(entity['displayName'], entity['profileUrl'], entity['authorPhotoUrl'])
  end
end

def parse_reviews(response_obj)
  response_obj.values.first['results']['annotations'].map do |annotation|
    created_at = DateTime.strptime(annotation['creationTimestamp'].to_s, '%s')
    Review.new(
      Author.from_annotation(annotation),
      annotation['comment'],
      annotation['starRating'],
      created_at
    )
  end
end

def parse_issues(response_obj)
  response_obj.values.first['results']['annotations'].map do |annotation|
    created_at = DateTime.strptime(annotation['timestamp'].to_s, '%s')
    Issue.new(
      Author.from_annotation(annotation),
      annotation['title'],
      annotation['comment'],
      annotation['attributes']['sfrAttributes']['issueType'],
      created_at
    )
  end
end

def fetch_reviews(extension_id)
  response = fetch_extension_thread(extension_id, 'chrome_webstore')
  parse_reviews(response)
end

def fetch_issues(extension_id)
  response = fetch_extension_thread(extension_id, 'chrome_webstore_support')
  parse_issues(response)
end

def load_config
  JSON.parse(File.read('config.json'))
end

config = load_config()

config['extensions'].each do |id|
  p fetch_reviews(id)
  p fetch_issues(id)
end

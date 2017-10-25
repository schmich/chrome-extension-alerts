require 'extension'
require 'date'
require 'pp'

=begin
comments = fetch_extension_comments('')
File.open('example.json', 'w') do |f|
  f.write(JSON.pretty_generate(comments))
end
=end

class Comment < Struct.new(:author, :comment, :rating, :created_at)
end

class Author < Struct.new(:name, :url, :image)
end

def create_comments(response_obj)
  response_obj.values.first['results']['annotations'].map do |annotation|
    entity = annotation['entity']
    author = Author.new(entity['displayName'], entity['profileUrl'], entity['authorPhotoUrl'])
    created_at = DateTime.strptime(annotation['creationTimestamp'].to_s, '%s')
    Comment.new(author, annotation['comment'], annotation['starRating'], created_at)
  end
end

response = JSON.parse(File.read('example.json'))
comments = create_comments(response)

# Holds the issue forms and /redhelm feedback together, where the plugin's own tests can't reach:
# the link's fields must be real fields of the bug form, every form is one GitHub can show and warns
# that issues are public, and a security problem has a private way in. It parses what it checks and
# matches code at the start of a line, so a comment never counts.
require 'yaml'

Encoding.default_external = 'UTF-8'
SECURITY = 'https://github.com/watLr/redhelm/security/advisories/new'
FORMS = '.github/ISSUE_TEMPLATE'
Dir.chdir(File.join(__dir__, '..'))

failed = []
check = ->(ok, what) { failed << what unless ok }
load_yaml = ->(path) { YAML.safe_load(File.read(path)) }

config = load_yaml.("#{FORMS}/config.yml")
check.(config['blank_issues_enabled'] == false, 'config.yml: blank issues must be off')
check.(config['contact_links'].any? { |l| l['url'] == SECURITY }, 'config.yml: no private security link')

forms = (Dir["#{FORMS}/*.yml"] - ["#{FORMS}/config.yml"]).sort
%w[bug_report feature_request feedback].each do |name|
  check.(forms.include?("#{FORMS}/#{name}.yml"), "#{name}.yml: missing")
end
forms.each do |path|
  form = load_yaml.(path)
  %w[name description].each do |key|
    check.(form[key].is_a?(String) && !form[key].empty?, "#{path}: no #{key}")
  end
  body = form.fetch('body')
  ids = body.map { |b| b['id'] }.compact
  check.(ids.uniq == ids, "#{path}: a field id is used twice")
  body.select { |b| b['type'] == 'dropdown' }.each do |b|
    check.(!Array(b.dig('attributes', 'options')).empty?, "#{path}: dropdown #{b['id']} has no options")
  end
  notes = body.select { |b| b['type'] == 'markdown' }.map { |b| b.dig('attributes', 'value') }.join("\n")
  check.(notes.include?('Issues are public'), "#{path}: no public warning")
  check.(notes.include?(SECURITY), "#{path}: no private security link") unless path.end_with?('feature_request.yml')
end

bug = load_yaml.("#{FORMS}/bug_report.yml").fetch('body')
%w[rh cc].each do |id|
  check.(bug.any? { |b| b['id'] == id && b['type'] == 'input' }, "bug_report.yml: no input field with id #{id}")
end

code = File.read('plugins/redhelm/hooks/model.ts').gsub(%r{/\*.*?\*/}m, '')
check.(code.match?(/^\s*const query = Object\.entries\(\{ rh: redhelm, cc: claude \}\)/), 'model.ts: the link no longer fills rh and cc')
check.(code.match?(%r{^\s*`\$\{REPO\}/security/advisories/new`,}) && code.match?(%r{^const REPO = 'https://github\.com/watLr/redhelm'}), 'model.ts: no private security link')
check.(File.read('SECURITY.md').include?(SECURITY), 'SECURITY.md: no private security link')

abort(failed.join("\n")) unless failed.empty?
puts 'Feedback forms and link agree'

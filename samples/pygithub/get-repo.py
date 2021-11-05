from github import Github
from termcolor import colored

# Just point base_url to your proxy server
client = Github(base_url="http://127.0.0.1:3000")

# a simple call to test if it is working
repo = client.get_repo("hsborges/github-proxy-server")

# print fields of the repository
print("%s:\t%s" % (colored("Full name", attrs=["bold"]), repo.full_name))
print("%s:\t%d" % (colored("Stargazers", attrs=["bold"]), repo.stargazers_count))
print("%s:\t%d" % (colored("Watchers", attrs=["bold"]), repo.subscribers_count))
print("%s:\t\t%s" % (colored("URL", attrs=["bold"]), repo.url))
print("%s:\t%s" % (colored("Created at", attrs=["bold"]), repo.created_at))
print("%s:\t%s" % (colored("Default branch", attrs=["bold"]), repo.default_branch))
print("(...)")

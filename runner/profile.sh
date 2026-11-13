# Sourced by /etc/profile, which Paperclip's SSH driver loads before every
# command. sshd starts sessions with a clean environment, so container ENV
# values never reach the agent; anything an agent CLI needs goes here.
export DISABLE_AUTOUPDATER=1

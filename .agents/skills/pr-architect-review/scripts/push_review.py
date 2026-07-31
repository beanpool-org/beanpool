#!/usr/bin/env python3
import argparse
import json
import os
import re
import subprocess
import sys

def run_cmd(cmd, check=True):
    # Always prepend GITHUB_TOKEN="" to environment to force keychain auth
    env = os.environ.copy()
    env.pop("GITHUB_TOKEN", None)
    res = subprocess.run(cmd, capture_output=True, text=True, env=env)
    if check and res.returncode != 0:
        print(f"Error running command: {' '.join(cmd)}", file=sys.stderr)
        print(f"Stdout:\n{res.stdout}", file=sys.stderr)
        print(f"Stderr:\n{res.stderr}", file=sys.stderr)
        sys.exit(res.returncode)
    return res

def parse_pr_url(url):
    # Matches URLs like https://github.com/owner/repo/pull/num or just owner/repo#num
    match = re.search(r"github\.com/([^/]+)/([^/]+)/pull/(\d+)", url)
    if match:
        return match.group(1), match.group(2), match.group(3)
    
    # Fallback to local parsing if it's just a number
    if url.isdigit():
        # Get remote origin url to find owner and repo
        res = run_cmd(["git", "config", "--get", "remote.origin.url"], check=False)
        if res.returncode == 0:
            git_url = res.stdout.strip()
            match = re.search(r"github\.com[:/]([^/]+)/([^.]+)", git_url)
            if match:
                return match.group(1), match.group(2), url
    raise ValueError(f"Could not parse GitHub PR URL or number from: {url}")

def main():
    parser = argparse.ArgumentParser(description="PR Architect Review Pusher")
    parser.add_argument("pr_url", help="GitHub PR URL or PR number")
    parser.add_argument("--comments-file", help="Path to JSON file containing comments. If omitted, reads from stdin.")
    parser.add_argument("--event", default="REQUEST_CHANGES", choices=["COMMENT", "REQUEST_CHANGES", "APPROVE"],
                        help="The type of review event to submit (default: REQUEST_CHANGES)")
    parser.add_argument("--dry-run", action="store_true", help="Print the API payloads instead of submitting them")
    
    args = parser.parse_args()
    
    # Parse PR information
    try:
        owner, repo, pr_number = parse_pr_url(args.pr_url)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
        
    # Read comments
    if args.comments_file:
        try:
            with open(args.comments_file, 'r') as f:
                comments = json.load(f)
        except Exception as e:
            print(f"Error reading comments file: {e}", file=sys.stderr)
            sys.exit(1)
    else:
        # Read from stdin
        try:
            content = sys.stdin.read().strip()
            if not content:
                print("Error: No comments provided on stdin.", file=sys.stderr)
                sys.exit(1)
            comments = json.loads(content)
        except Exception as e:
            print(f"Error parsing JSON from stdin: {e}", file=sys.stderr)
            sys.exit(1)

    if not isinstance(comments, list):
        print("Error: Comments must be a list/array of objects.", file=sys.stderr)
        sys.exit(1)

    print(f"Processing review for {owner}/{repo} PR #{pr_number}...")
    
    # Get head SHA
    if args.dry_run:
        head_sha = "MOCK_HEAD_SHA_FOR_DRY_RUN"
    else:
        print("Fetching PR head commit SHA...")
        res = run_cmd(["gh", "api", f"repos/{owner}/{repo}/pulls/{pr_number}", "--jq", ".head.sha"])
        head_sha = res.stdout.strip()
        if not head_sha:
            print("Error: Could not retrieve head SHA for the PR.", file=sys.stderr)
            sys.exit(1)
        print(f"PR head SHA: {head_sha}")

    # Build review payload
    api_comments = []
    for idx, c in enumerate(comments):
        path = c.get("path")
        position = c.get("position")
        body = c.get("body")
        side = c.get("side", "RIGHT")
        
        if not path or position is None or not body:
            print(f"Warning: Comment index {idx} is missing required fields (path, position, body). Skipping.", file=sys.stderr)
            continue
            
        api_comments.append({
            "path": path,
            "line": int(position),
            "side": side,
            "body": body
        })

    payload = {
        "commit_id": head_sha,
        "event": args.event,
        "body": "Automated code review by Senior Developer and Technical Architect.",
        "comments": api_comments
    }

    if args.dry_run:
        print("\n=== DRY RUN: Review Payload ===")
        print(json.dumps(payload, indent=2))
        return

    # Attempt to post bulk review
    print(f"Submitting bulk review with {len(api_comments)} comments as {args.event}...")
    
    # Write payload to a temporary file or pass it to stdin of gh api
    temp_payload_path = f".pr_review_payload_{pr_number}.json"
    try:
        with open(temp_payload_path, 'w') as f:
            json.dump(payload, f)
            
        review_cmd = [
            "gh", "api", 
            f"repos/{owner}/{repo}/pulls/{pr_number}/reviews", 
            "--method", "POST", 
            "--input", temp_payload_path
        ]
        
        res = run_cmd(review_cmd, check=False)
        
        if res.returncode == 0:
            print(f"Successfully posted bulk review to PR #{pr_number}! 🎉")
            sys.exit(0)
            
        # If bulk review failed, we parse errors and try individual fallback
        print("Bulk review submission failed. Stderr output:")
        print(res.stderr, file=sys.stderr)
        print("\nAttempting fallback to individual comment submission...")
        
        # Post comments one-by-one
        success_count = 0
        fail_count = 0
        
        for c in api_comments:
            comment_payload = {
                "body": c["body"],
                "commit_id": head_sha,
                "path": c["path"],
                "line": c["line"],
                "side": c["side"]
            }
            
            with open(temp_payload_path, 'w') as f:
                json.dump(comment_payload, f)
                
            comment_cmd = [
                "gh", "api", 
                f"repos/{owner}/{repo}/pulls/{pr_number}/comments", 
                "--method", "POST", 
                "--input", temp_payload_path
            ]
            
            single_res = run_cmd(comment_cmd, check=False)
            if single_res.returncode == 0:
                print(f"✅ Posted comment to {c['path']}:{c['line']} ({c['side']})")
                success_count += 1
            else:
                print(f"❌ Failed to post comment to {c['path']}:{c['line']} ({c['side']})")
                print(f"   Error: {single_res.stderr.strip()}", file=sys.stderr)
                fail_count += 1
                
        print(f"\nReview fallback completed: {success_count} success, {fail_count} failed.")
        if success_count > 0:
            sys.exit(0)
        else:
            sys.exit(1)
            
    finally:
        if os.path.exists(temp_payload_path):
            os.remove(temp_payload_path)

if __name__ == "__main__":
    main()

---
name: tavily-search
description: >
  Search the web using the Tavily Search API for AI-optimized results.
  Use when you need comprehensive, up-to-date web search results with
  summaries, source URLs, and relevance scoring. Supports search depth
  control (basic/advanced), domain filtering, and raw content extraction.
  Preferred over DuckDuckGo when TAVILY_API_KEY is configured.
---

# Tavily Search

Search the web using [Tavily](https://tavily.com) — an AI-native search API that returns clean, relevant results.

## Usage

```bash
curl -s -X POST https://api.tavily.com/search \
  -H "Content-Type: application/json" \
  -d '{
    "api_key": "'$TAVILY_API_KEY'",
    "query": "your search query",
    "search_depth": "advanced",
    "include_answer": true,
    "max_results": 5
  }'
```

## Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | required | The search query |
| `search_depth` | string | `"basic"` | `"basic"` for fast results, `"advanced"` for thorough |
| `include_answer` | bool | `false` | Include an AI-generated answer summary |
| `include_raw_content` | bool | `false` | Include raw page content |
| `max_results` | int | `5` | Number of results (1-20) |
| `include_domains` | array | `[]` | Only search these domains |
| `exclude_domains` | array | `[]` | Exclude these domains |

## Environment

- `TAVILY_API_KEY` — Required. Get a free key at https://tavily.com

## When to Use

- Prefer Tavily over DuckDuckGo for research queries — results are higher quality and include summaries.
- Use `search_depth: "advanced"` for complex research, `"basic"` for quick lookups.
- Use `include_answer: true` when you need a quick summary without reading full pages.

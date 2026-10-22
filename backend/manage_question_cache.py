"""List cached answers and change their local review status."""

from __future__ import annotations

import argparse
import json
import sqlite3

from app.services.question_cache import init_db
from app.services.usage_store import database_path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("list", help="show cached question IDs and review status")
    status_parser = subparsers.add_parser("status", help="change a record's review status")
    status_parser.add_argument("record_id", type=int)
    status_parser.add_argument("value", choices=("unverified", "verified", "rejected"))
    args = parser.parse_args()

    init_db()
    with sqlite3.connect(database_path()) as connection:
        connection.row_factory = sqlite3.Row
        if args.command == "list":
            rows = connection.execute(
                "SELECT id, original_question, response_json, status, usage_count "
                "FROM question_cache ORDER BY id"
            ).fetchall()
            for row in rows:
                response = json.loads(row["response_json"])
                print(
                    f"#{row['id']} [{row['status']}; used {row['usage_count']} times]\n"
                    f"Question: {row['original_question']}\n"
                    f"Suggested answer: {response['suggested_answer']}\n"
                )
            if not rows:
                print("Question cache is empty.")
            return 0

        cursor = connection.execute(
            "UPDATE question_cache SET status = ? WHERE id = ?",
            (args.value, args.record_id),
        )
        if cursor.rowcount == 0:
            print(f"No cache record found with ID {args.record_id}.")
            return 1
        print(f"Cache record #{args.record_id} status set to {args.value}.")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())

# app/services/myutils.py
from typing import List, Union
from openai import OpenAI

class MyUtils:
    def __init__(self):
        self.client = OpenAI()

    def embed(self, texts: Union[str, List[str]], model: str = "text-embedding-3-small"):
        """
        - If `texts` is a str, return list[float] (length 1536).
        - If `texts` is a list[str], return list[list[float]].
        """
        resp = self.client.embeddings.create(
            model=model,
            input=texts,                 # default returns floats (not base64)
            # encoding_format="float",   # optional: explicit
        )
        if isinstance(texts, str):
            return resp.data[0].embedding         # ✅ flat vector
        else:
            return [d.embedding for d in resp.data]  # batch: list of vectors
# Base image from the official Memobase repository
# This allows us to inherit all upstream features while adding our own customizations
FROM ghcr.io/memodb-io/memobase:latest

# Set the working directory
WORKDIR /app

# If you have custom python requirements, uncomment the following lines:
# COPY requirements.txt .
# RUN pip install --no-cache-dir -r requirements.txt

# If you have custom python code (e.g. modified logic), copy it here:
# COPY ./src /app/src

# Setup environment variables (Defaults that can be overridden)
ENV PYTHONUNBUFFERED=1

# Expose the API port
EXPOSE 8019

# The command is inherited from the base image, but can be overridden
# CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8019"]

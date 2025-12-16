#!/bin/bash

# Deploy Co-Create Dashboard to GCP Cloud Storage
# Prerequisites: gcloud CLI authenticated

BUCKET_NAME="co-create-dataset"
DASHBOARD_DIR="$(dirname "$0")"

echo "Deploying Co-Create Dashboard to gs://$BUCKET_NAME/dashboard/"

# Step 1: Set CORS on the bucket (allows browser access to bucket listing)
echo "Setting CORS configuration..."
gsutil cors set "$DASHBOARD_DIR/cors.json" "gs://$BUCKET_NAME"

# Step 2: Upload dashboard files
echo "Uploading dashboard files..."
gsutil -m cp "$DASHBOARD_DIR/index.html" "gs://$BUCKET_NAME/dashboard/"
gsutil -m cp "$DASHBOARD_DIR/contributions.html" "gs://$BUCKET_NAME/dashboard/"
gsutil -m cp "$DASHBOARD_DIR/viewer.html" "gs://$BUCKET_NAME/dashboard/"

# Step 3: Set public read access
echo "Setting public access..."
gsutil iam ch allUsers:objectViewer "gs://$BUCKET_NAME"

# Step 4: Set content type and caching
echo "Setting metadata..."
gsutil setmeta -h "Content-Type:text/html" -h "Cache-Control:public, max-age=300" "gs://$BUCKET_NAME/dashboard/*.html"

echo ""
echo "Deployment complete!"
echo ""
echo "Dashboard URL: https://storage.googleapis.com/$BUCKET_NAME/dashboard/index.html"
echo ""
echo "You can also set up a custom domain or use Firebase Hosting for a cleaner URL."

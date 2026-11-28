import Button from '@app/components/Common/Button';
import ConfirmButton from '@app/components/Common/ConfirmButton';
import Modal from '@app/components/Common/Modal';
import RotationBadge from '@app/components/Rotation/RotationBadge';
import useRotationMembership from '@app/hooks/rotation/useRotationMembership';
import type {
  CollectionFormConfig,
  CollectionSortOrder,
  PlexHubConfig,
  PreExistingCollectionConfig,
} from '@app/types/collections';
import { CollectionType } from '@app/types/collections';
import { pendingCollectionName } from '@app/utils/collections/sortTitle';
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  FunnelIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import type { CollectionSuffixMode } from '@server/constants/sortTitle';
import type { Membership } from '@server/interfaces/api/rotationInterfaces';
import axios from 'axios';
import type React from 'react';
import { useMemo, useState } from 'react';
import { defineMessages, useIntl } from 'react-intl';
import { useToasts } from 'react-toast-notifications';
import type { ColumnFit } from './useColumnWidths';
import { useColumnWidths } from './useColumnWidths';

const messages = defineMessages({
  bulkEditTitle: 'Bulk Edit Collections',
  bulkEditDescription:
    'Select collections and edit multiple fields at once. Changes apply only to selected collections.',
  selectAll: 'Select All',
  deselectAll: 'Deselect All',
  selectedCount: '{count} selected',
  save: 'Save Changes',
  close: 'Close',
  saving: 'Saving...',
  successToast: 'Successfully updated {count} collection(s)',
  errorToast: 'Failed to update {name}: {error}',
  allTypes: 'All Types',
  allLibraries: 'All Libraries',
  agregarrCollections: 'Agregarr Collections',
  plexHubs: 'Plex Hubs',
  preExistingCollections: 'Pre-existing Collections',
  collectionName: 'Collection Name',
  type: 'Type',
  library: 'Library',
  usersHome: 'Users Home',
  serverOwnerHome: 'Server Owner Home',
  libraryRecommended: 'Library Recommended',
  maxItems: 'Max Items',
  randomizeHomeOrder: 'Randomize Home Order',
  sortOrder: 'Sort Order',
  downloadMode: 'Download Mode',
  searchMissingMovies: 'Search Missing Movies',
  searchMissingTV: 'Search Missing TV',
  autoApproveMovies: 'Auto Approve Movies',
  autoApproveTV: 'Auto Approve TV',
  maxSeasonsToRequest: 'Max Seasons to Request',
  seasonsPerShowLimit: 'Seasons Per Show Limit',
  seasonGrabOrder: 'Season Grab Order',
  maxPositionToProcess: 'Max Position to Process',
  minimumYear: 'Minimum Year',
  minimumImdbRating: 'Minimum IMDb Rating',
  minimumRottenTomatoesRating: 'Minimum RT Rating',
  minimumRottenTomatoesAudienceRating: 'Minimum RT Audience Rating',
  showUnwatchedOnly: 'Unwatched Only',
  createPlaceholders: 'Create Placeholders',
  editValues: 'Edit Selected',
  noCollections: 'No collections available',
  overseerrMode: 'Seerr',
  directMode: 'Direct',
  yes: 'Yes',
  no: 'No',
  defaultSort: 'Default',
  reverseSort: 'Reverse',
  randomSort: 'Random',
  firstSeason: 'First',
  latestSeason: 'Latest',
  airingSeason: 'Airing',
  noCollectionsSelected: 'No collections selected',
  rotationOwnSaveFailed:
    "Couldn't save this collection's own visibility setting. The rotation keeps using the previous one.",
  collectionSuffix: 'Collection Suffix',
  collectionSuffixLeave: 'Leave As Is',
  collectionSuffixStrip: 'Remove " Collection"',
  collectionSuffixAdd: 'Add " Collection"',
  resetSortTitles: 'Reset Sort Titles ({count})',
  resetSortTitlesConfirm: 'Reset {count}?',
  resetSortTitlesToast:
    'Sort titles reset for {count} collection(s). Plex updates on the next sync.',
  suffixCellLeave: 'Leave',
  suffixCellStrip: 'Remove',
  suffixCellAdd: 'Add',
  resetColumnWidths: 'Reset Column Widths',
  resizeColumn: 'Drag to resize, double-click to fit',
});

// Short forms keep the column narrow; the edit row's dropdown spells them out.
const suffixCellMessages: Record<
  CollectionSuffixMode,
  (typeof messages)[keyof typeof messages]
> = {
  leave: messages.suffixCellLeave,
  strip: messages.suffixCellStrip,
  add: messages.suffixCellAdd,
};

interface BulkEditModalProps {
  collections: CollectionFormConfig[];
  hubs: PlexHubConfig[];
  preExisting: PreExistingCollectionConfig[];
  onClose: () => void;
  onSave: () => void; // Callback to revalidate data
}

type UnifiedCollection = {
  id: string;
  name: string;
  type: 'collection' | 'hub' | 'preExisting';
  collectionType?: CollectionType;
  libraryName: string;
  libraryId: string;
  // Visibility
  visibilityConfig: {
    usersHome: boolean;
    serverOwnerHome: boolean;
    libraryRecommended: boolean;
  };
  // Common fields
  maxItems?: number;
  randomizeHomeOrder?: boolean;
  // Collection-specific fields
  sortOrder?: CollectionSortOrder;
  downloadMode?: 'overseerr' | 'direct';
  searchMissingMovies?: boolean;
  searchMissingTV?: boolean;
  autoApproveMovies?: boolean;
  autoApproveTV?: boolean;
  maxSeasonsToRequest?: number;
  seasonsPerShowLimit?: number;
  seasonGrabOrder?: 'first' | 'latest' | 'airing';
  maxPositionToProcess?: number;
  minimumYear?: number;
  minimumImdbRating?: number;
  minimumRottenTomatoesRating?: number;
  minimumRottenTomatoesAudienceRating?: number;
  showUnwatchedOnly?: boolean;
  createPlaceholdersForMissing?: boolean;
  membership?: Membership;
  collectionSuffixMode?: CollectionSuffixMode;
  // Original config for saving
  originalConfig:
    | CollectionFormConfig
    | PlexHubConfig
    | PreExistingCollectionConfig;
};

const BulkEditModal: React.FC<BulkEditModalProps> = ({
  collections,
  hubs,
  preExisting,
  onClose,
  onSave,
}) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { map: rotationMap, revalidate: revalidateRotation } =
    useRotationMembership();

  // Selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Filter and sort state - default to Agregarr collections
  const [filterType, setFilterType] = useState<string>('agregarr');
  const [filterLibrary, setFilterLibrary] = useState<string>('all');
  const [sortColumn, setSortColumn] = useState<string>('name');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');

  // Edit values state
  const [editValues, setEditValues] = useState<{
    visibilityConfig?: {
      usersHome?: boolean;
      serverOwnerHome?: boolean;
      libraryRecommended?: boolean;
    };
    maxItems?: number | '';
    randomizeHomeOrder?: boolean;
    sortOrder?: CollectionSortOrder | '';
    downloadMode?: 'overseerr' | 'direct' | '';
    searchMissingMovies?: boolean;
    searchMissingTV?: boolean;
    autoApproveMovies?: boolean;
    autoApproveTV?: boolean;
    maxSeasonsToRequest?: number | '';
    seasonsPerShowLimit?: number | '';
    seasonGrabOrder?: 'first' | 'latest' | 'airing' | '';
    maxPositionToProcess?: number | '';
    minimumYear?: number | '';
    minimumImdbRating?: number | '';
    minimumRottenTomatoesRating?: number | '';
    minimumRottenTomatoesAudienceRating?: number | '';
    showUnwatchedOnly?: boolean;
    createPlaceholdersForMissing?: boolean;
    collectionSuffixMode?: CollectionSuffixMode | '';
  }>({});

  // Saving state
  const [isSaving, setIsSaving] = useState(false);
  // Remounts the reset button so each reset asks for its own confirmation.
  const [resetRound, setResetRound] = useState(0);

  // Transform all collections into unified format
  const unifiedCollections = useMemo((): UnifiedCollection[] => {
    const unified: UnifiedCollection[] = [];

    // Agregarr Collections
    collections.forEach((config) => {
      const membership = rotationMap[`collection:${config.id}`];
      unified.push({
        id: `collection-${config.id}`,
        name: config.name,
        type: 'collection',
        collectionType: CollectionType.AGREGARR_CREATED,
        libraryName: config.libraryName,
        libraryId: config.libraryId,
        visibilityConfig:
          membership?.own?.visibilityConfig ?? config.visibilityConfig,
        maxItems: config.maxItems,
        randomizeHomeOrder:
          membership?.own?.randomizeHomeOrder ?? config.randomizeHomeOrder,
        sortOrder: config.sortOrder,
        downloadMode: config.downloadMode,
        searchMissingMovies: config.searchMissingMovies,
        searchMissingTV: config.searchMissingTV,
        autoApproveMovies: config.autoApproveMovies,
        autoApproveTV: config.autoApproveTV,
        maxSeasonsToRequest: config.maxSeasonsToRequest,
        seasonsPerShowLimit: config.seasonsPerShowLimit,
        seasonGrabOrder: config.seasonGrabOrder,
        maxPositionToProcess: config.maxPositionToProcess,
        minimumYear: config.minimumYear,
        minimumImdbRating: config.minimumImdbRating,
        minimumRottenTomatoesRating: config.minimumRottenTomatoesRating,
        minimumRottenTomatoesAudienceRating:
          config.minimumRottenTomatoesAudienceRating,
        showUnwatchedOnly: config.showUnwatchedOnly,
        createPlaceholdersForMissing: config.createPlaceholdersForMissing,
        membership,
        originalConfig: config,
      });
    });

    // Plex Hubs
    hubs.forEach((hub) => {
      unified.push({
        id: `hub-${hub.id}`,
        name: hub.name,
        type: 'hub',
        collectionType: CollectionType.DEFAULT_PLEX_HUB,
        libraryName: hub.libraryName,
        libraryId: hub.libraryId,
        visibilityConfig: hub.visibilityConfig,
        randomizeHomeOrder: hub.randomizeHomeOrder,
        originalConfig: hub,
      });
    });

    // Pre-existing Collections
    preExisting.forEach((pre) => {
      const membership = rotationMap[`preExisting:${pre.id}`];
      unified.push({
        id: `preExisting-${pre.id}`,
        name: pendingCollectionName(
          pre.name,
          pre.collectionSuffixMode,
          pre.collectionSuffixRenameFailed
        ),
        type: 'preExisting',
        collectionType: CollectionType.PRE_EXISTING,
        libraryName: pre.libraryName,
        libraryId: pre.libraryId,
        visibilityConfig:
          membership?.own?.visibilityConfig ?? pre.visibilityConfig,
        randomizeHomeOrder:
          membership?.own?.randomizeHomeOrder ?? pre.randomizeHomeOrder,
        membership,
        collectionSuffixMode: pre.collectionSuffixMode,
        originalConfig: pre,
      });
    });

    return unified;
  }, [collections, hubs, preExisting, rotationMap]);

  // Get unique libraries for filter
  const uniqueLibraries = useMemo(() => {
    const librarySet = new Set(unifiedCollections.map((c) => c.libraryName));
    return Array.from(librarySet).sort();
  }, [unifiedCollections]);

  // Apply filters and sorting
  const filteredAndSortedCollections = useMemo(() => {
    let filtered = [...unifiedCollections];

    // Apply type filter
    if (filterType !== 'all') {
      filtered = filtered.filter((c) => {
        if (filterType === 'agregarr') return c.type === 'collection';
        if (filterType === 'hub') return c.type === 'hub';
        if (filterType === 'preexisting') return c.type === 'preExisting';
        return true;
      });
    }

    // Apply library filter
    if (filterLibrary !== 'all') {
      filtered = filtered.filter((c) => c.libraryName === filterLibrary);
    }

    // Apply sorting
    const sorted = [...filtered].sort((a, b) => {
      let comparison = 0;

      switch (sortColumn) {
        case 'name':
          comparison = a.name.localeCompare(b.name);
          break;
        case 'type':
          comparison = a.type.localeCompare(b.type);
          break;
        case 'library':
          comparison = a.libraryName.localeCompare(b.libraryName);
          break;
        case 'usersHome':
          comparison =
            (a.visibilityConfig.usersHome ? 1 : 0) -
            (b.visibilityConfig.usersHome ? 1 : 0);
          break;
        case 'serverOwnerHome':
          comparison =
            (a.visibilityConfig.serverOwnerHome ? 1 : 0) -
            (b.visibilityConfig.serverOwnerHome ? 1 : 0);
          break;
        case 'libraryRecommended':
          comparison =
            (a.visibilityConfig.libraryRecommended ? 1 : 0) -
            (b.visibilityConfig.libraryRecommended ? 1 : 0);
          break;
        case 'maxItems':
          comparison = (a.maxItems || 0) - (b.maxItems || 0);
          break;
        case 'randomizeHomeOrder':
          comparison =
            (a.randomizeHomeOrder ? 1 : 0) - (b.randomizeHomeOrder ? 1 : 0);
          break;
        case 'sortOrder':
          comparison = (a.sortOrder || 'default').localeCompare(
            b.sortOrder || 'default'
          );
          break;
        case 'downloadMode':
          comparison = (a.downloadMode || '').localeCompare(
            b.downloadMode || ''
          );
          break;
        case 'searchMissingMovies':
          comparison =
            (a.searchMissingMovies ? 1 : 0) - (b.searchMissingMovies ? 1 : 0);
          break;
        case 'searchMissingTV':
          comparison =
            (a.searchMissingTV ? 1 : 0) - (b.searchMissingTV ? 1 : 0);
          break;
        case 'autoApproveMovies':
          comparison =
            (a.autoApproveMovies ? 1 : 0) - (b.autoApproveMovies ? 1 : 0);
          break;
        case 'autoApproveTV':
          comparison = (a.autoApproveTV ? 1 : 0) - (b.autoApproveTV ? 1 : 0);
          break;
        case 'maxSeasonsToRequest':
          comparison =
            (a.maxSeasonsToRequest || 0) - (b.maxSeasonsToRequest || 0);
          break;
        case 'seasonsPerShowLimit':
          comparison =
            (a.seasonsPerShowLimit || 0) - (b.seasonsPerShowLimit || 0);
          break;
        case 'seasonGrabOrder':
          comparison = (a.seasonGrabOrder || '').localeCompare(
            b.seasonGrabOrder || ''
          );
          break;
        case 'maxPositionToProcess':
          comparison =
            (a.maxPositionToProcess || 0) - (b.maxPositionToProcess || 0);
          break;
        case 'minimumYear':
          comparison = (a.minimumYear || 0) - (b.minimumYear || 0);
          break;
        case 'minimumImdbRating':
          comparison = (a.minimumImdbRating || 0) - (b.minimumImdbRating || 0);
          break;
        case 'minimumRottenTomatoesRating':
          comparison =
            (a.minimumRottenTomatoesRating || 0) -
            (b.minimumRottenTomatoesRating || 0);
          break;
        case 'minimumRottenTomatoesAudienceRating':
          comparison =
            (a.minimumRottenTomatoesAudienceRating || 0) -
            (b.minimumRottenTomatoesAudienceRating || 0);
          break;
        case 'showUnwatchedOnly':
          comparison =
            (a.showUnwatchedOnly ? 1 : 0) - (b.showUnwatchedOnly ? 1 : 0);
          break;
        case 'createPlaceholdersForMissing':
          comparison =
            (a.createPlaceholdersForMissing ? 1 : 0) -
            (b.createPlaceholdersForMissing ? 1 : 0);
          break;
        case 'collectionSuffixMode':
          comparison = (a.collectionSuffixMode || '').localeCompare(
            b.collectionSuffixMode || ''
          );
          break;
        default:
          comparison = 0;
      }

      return sortDirection === 'asc' ? comparison : -comparison;
    });

    return sorted;
  }, [
    unifiedCollections,
    filterType,
    filterLibrary,
    sortColumn,
    sortDirection,
  ]);

  // Select/Deselect all
  const handleSelectAll = () => {
    const allIds = new Set(filteredAndSortedCollections.map((c) => c.id));
    setSelectedIds(allIds);
  };

  const handleDeselectAll = () => {
    setSelectedIds(new Set());
  };

  // Toggle individual selection
  const toggleSelection = (id: string) => {
    const newSelected = new Set(selectedIds);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedIds(newSelected);
  };

  // Handle column header click for sorting
  const handleColumnSort = (column: string) => {
    if (sortColumn === column) {
      // Toggle direction if same column
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      // New column, default to ascending
      setSortColumn(column);
      setSortDirection('asc');
    }
  };

  // Render sort indicator for column header
  const renderSortIndicator = (column: string) => {
    if (sortColumn !== column) {
      return null;
    }
    return sortDirection === 'asc' ? (
      <ChevronUpIcon className="ml-1 inline h-3 w-3" />
    ) : (
      <ChevronDownIcon className="ml-1 inline h-3 w-3" />
    );
  };

  // Check if field is applicable for collection type
  const isFieldApplicable = (
    field: string,
    type: 'collection' | 'hub' | 'preExisting'
  ): boolean => {
    // Common fields available to all types
    const commonFields = [
      'usersHome',
      'serverOwnerHome',
      'libraryRecommended',
      'randomizeHomeOrder',
    ];

    if (commonFields.includes(field)) {
      return true;
    }

    // Collection-specific fields
    const collectionOnlyFields = [
      'maxItems',
      'sortOrder',
      'downloadMode',
      'searchMissingMovies',
      'searchMissingTV',
      'autoApproveMovies',
      'autoApproveTV',
      'maxSeasonsToRequest',
      'seasonsPerShowLimit',
      'seasonGrabOrder',
      'maxPositionToProcess',
      'minimumYear',
      'minimumImdbRating',
      'minimumRottenTomatoesRating',
      'minimumRottenTomatoesAudienceRating',
      'showUnwatchedOnly',
      'createPlaceholdersForMissing',
    ];

    if (collectionOnlyFields.includes(field)) {
      return type === 'collection';
    }

    if (field === 'collectionSuffixMode') {
      return type === 'preExisting';
    }

    // Plex hubs have no sort title of Agregarr's to reset.
    if (field === 'sortTitle') {
      return type !== 'hub';
    }

    return false;
  };

  // Save changes
  const handleSave = async () => {
    if (selectedIds.size === 0) {
      addToast(intl.formatMessage(messages.noCollectionsSelected), {
        appearance: 'error',
        autoDismiss: true,
      });
      return;
    }

    setIsSaving(true);

    let successCount = 0;
    let rotationChanged = false;

    // Get selected collections
    const selectedCollections = unifiedCollections.filter((c) =>
      selectedIds.has(c.id)
    );

    // Update each selected collection
    for (const collection of selectedCollections) {
      try {
        // Build updated config by merging edit values with original
        // Create a mutable copy to avoid readonly errors
        const baseConfig = { ...collection.originalConfig };

        // Build the updated configuration object
        const updatedFields: Record<string, unknown> = {};

        // Apply visibility changes if set
        if (editValues.visibilityConfig) {
          updatedFields.visibilityConfig = {
            ...baseConfig.visibilityConfig,
            ...(editValues.visibilityConfig.usersHome !== undefined && {
              usersHome: editValues.visibilityConfig.usersHome,
            }),
            ...(editValues.visibilityConfig.serverOwnerHome !== undefined && {
              serverOwnerHome: editValues.visibilityConfig.serverOwnerHome,
            }),
            ...(editValues.visibilityConfig.libraryRecommended !==
              undefined && {
              libraryRecommended:
                editValues.visibilityConfig.libraryRecommended,
            }),
          };
        }

        // Apply other field changes if applicable
        if (
          editValues.maxItems !== undefined &&
          isFieldApplicable('maxItems', collection.type)
        ) {
          updatedFields.maxItems =
            editValues.maxItems === '' ? undefined : editValues.maxItems;
        }

        if (
          editValues.randomizeHomeOrder !== undefined &&
          isFieldApplicable('randomizeHomeOrder', collection.type)
        ) {
          updatedFields.randomizeHomeOrder = editValues.randomizeHomeOrder;
        }

        if (
          editValues.sortOrder !== undefined &&
          editValues.sortOrder !== '' &&
          isFieldApplicable('sortOrder', collection.type)
        ) {
          updatedFields.sortOrder = editValues.sortOrder;
        }

        if (
          editValues.downloadMode !== undefined &&
          editValues.downloadMode !== '' &&
          isFieldApplicable('downloadMode', collection.type)
        ) {
          updatedFields.downloadMode = editValues.downloadMode;
        }

        if (
          editValues.searchMissingMovies !== undefined &&
          isFieldApplicable('searchMissingMovies', collection.type)
        ) {
          updatedFields.searchMissingMovies = editValues.searchMissingMovies;
        }

        if (
          editValues.searchMissingTV !== undefined &&
          isFieldApplicable('searchMissingTV', collection.type)
        ) {
          updatedFields.searchMissingTV = editValues.searchMissingTV;
        }

        if (
          editValues.autoApproveMovies !== undefined &&
          isFieldApplicable('autoApproveMovies', collection.type)
        ) {
          updatedFields.autoApproveMovies = editValues.autoApproveMovies;
        }

        if (
          editValues.autoApproveTV !== undefined &&
          isFieldApplicable('autoApproveTV', collection.type)
        ) {
          updatedFields.autoApproveTV = editValues.autoApproveTV;
        }

        if (
          editValues.maxSeasonsToRequest !== undefined &&
          isFieldApplicable('maxSeasonsToRequest', collection.type)
        ) {
          updatedFields.maxSeasonsToRequest =
            editValues.maxSeasonsToRequest === ''
              ? undefined
              : editValues.maxSeasonsToRequest;
        }

        if (
          editValues.seasonsPerShowLimit !== undefined &&
          isFieldApplicable('seasonsPerShowLimit', collection.type)
        ) {
          updatedFields.seasonsPerShowLimit =
            editValues.seasonsPerShowLimit === ''
              ? undefined
              : editValues.seasonsPerShowLimit;
        }

        if (
          editValues.seasonGrabOrder !== undefined &&
          isFieldApplicable('seasonGrabOrder', collection.type)
        ) {
          updatedFields.seasonGrabOrder =
            editValues.seasonGrabOrder === ''
              ? undefined
              : editValues.seasonGrabOrder;
        }

        if (
          editValues.maxPositionToProcess !== undefined &&
          isFieldApplicable('maxPositionToProcess', collection.type)
        ) {
          updatedFields.maxPositionToProcess =
            editValues.maxPositionToProcess === ''
              ? undefined
              : editValues.maxPositionToProcess;
        }

        if (
          editValues.minimumYear !== undefined &&
          isFieldApplicable('minimumYear', collection.type)
        ) {
          updatedFields.minimumYear =
            editValues.minimumYear === '' ? undefined : editValues.minimumYear;
        }

        if (
          editValues.minimumImdbRating !== undefined &&
          isFieldApplicable('minimumImdbRating', collection.type)
        ) {
          updatedFields.minimumImdbRating =
            editValues.minimumImdbRating === ''
              ? undefined
              : editValues.minimumImdbRating;
        }

        if (
          editValues.minimumRottenTomatoesRating !== undefined &&
          isFieldApplicable('minimumRottenTomatoesRating', collection.type)
        ) {
          updatedFields.minimumRottenTomatoesRating =
            editValues.minimumRottenTomatoesRating === ''
              ? undefined
              : editValues.minimumRottenTomatoesRating;
        }

        if (
          editValues.minimumRottenTomatoesAudienceRating !== undefined &&
          isFieldApplicable(
            'minimumRottenTomatoesAudienceRating',
            collection.type
          )
        ) {
          updatedFields.minimumRottenTomatoesAudienceRating =
            editValues.minimumRottenTomatoesAudienceRating === ''
              ? undefined
              : editValues.minimumRottenTomatoesAudienceRating;
        }

        if (
          editValues.showUnwatchedOnly !== undefined &&
          isFieldApplicable('showUnwatchedOnly', collection.type)
        ) {
          updatedFields.showUnwatchedOnly = editValues.showUnwatchedOnly;
        }

        if (
          editValues.createPlaceholdersForMissing !== undefined &&
          isFieldApplicable('createPlaceholdersForMissing', collection.type)
        ) {
          updatedFields.createPlaceholdersForMissing =
            editValues.createPlaceholdersForMissing;
        }

        if (
          editValues.collectionSuffixMode &&
          isFieldApplicable('collectionSuffixMode', collection.type)
        ) {
          updatedFields.collectionSuffixMode = editValues.collectionSuffixMode;
        }

        // Merge updated fields into the base config
        const updatedConfig = { ...baseConfig, ...updatedFields };

        const own = collection.membership?.own;
        if (
          collection.membership &&
          own &&
          (editValues.visibilityConfig ||
            (editValues.randomizeHomeOrder !== undefined &&
              isFieldApplicable('randomizeHomeOrder', collection.type)))
        ) {
          try {
            await axios.patch(
              `/api/v1/rotation-groups/membership/${collection.type}/${collection.originalConfig.id}`,
              {
                ...(editValues.visibilityConfig && {
                  visibilityConfig: {
                    ...own.visibilityConfig,
                    ...(editValues.visibilityConfig.usersHome !== undefined && {
                      usersHome: editValues.visibilityConfig.usersHome,
                    }),
                    ...(editValues.visibilityConfig.serverOwnerHome !==
                      undefined && {
                      serverOwnerHome:
                        editValues.visibilityConfig.serverOwnerHome,
                    }),
                    ...(editValues.visibilityConfig.libraryRecommended !==
                      undefined && {
                      libraryRecommended:
                        editValues.visibilityConfig.libraryRecommended,
                    }),
                  },
                }),
                ...(editValues.randomizeHomeOrder !== undefined && {
                  randomizeHomeOrder: editValues.randomizeHomeOrder,
                }),
              }
            );
            rotationChanged = true;
          } catch {
            addToast(intl.formatMessage(messages.rotationOwnSaveFailed), {
              appearance: 'warning',
              autoDismiss: true,
            });
          }
        }

        // Call appropriate API endpoint based on type
        if (collection.type === 'collection') {
          await axios.put(`/api/v1/collections/${updatedConfig.id}/settings`, {
            ...updatedConfig,
            // Strip computed fields
            isActive: undefined,
            missing: undefined,
          });
        } else if (collection.type === 'hub') {
          await axios.put(`/api/v1/defaulthubs/${updatedConfig.id}/settings`, {
            ...updatedConfig,
            // Strip computed fields
            isActive: undefined,
            collectionType: undefined,
            missing: undefined,
          });
        } else if (collection.type === 'preExisting') {
          await axios.put(`/api/v1/preexisting/${updatedConfig.id}/settings`, {
            ...updatedConfig,
            // Strip computed fields
            isActive: undefined,
            collectionType: undefined,
            missing: undefined,
          });
        }

        successCount++;
      } catch (error) {
        addToast(
          intl.formatMessage(messages.errorToast, {
            name: collection.name,
            error: error instanceof Error ? error.message : 'Unknown error',
          }),
          {
            appearance: 'error',
            autoDismiss: true,
          }
        );
      }
    }

    setIsSaving(false);

    if (rotationChanged) {
      await revalidateRotation();
    }

    if (successCount > 0) {
      addToast(
        intl.formatMessage(messages.successToast, { count: successCount }),
        {
          appearance: 'success',
          autoDismiss: true,
        }
      );
      // Call onSave to revalidate without closing modal
      onSave();
      // Clear edit values after successful save
      setEditValues({});
    }
  };

  const sortTitleResetTargets = unifiedCollections.filter(
    (c) => selectedIds.has(c.id) && isFieldApplicable('sortTitle', c.type)
  );

  // Agregarr collections get the form's cleared Sort Title request; pre-existing ones resetSortTitle, which also covers a title set in Plex.
  const handleResetSortTitles = async () => {
    setIsSaving(true);
    let resetCount = 0;
    for (const collection of sortTitleResetTargets) {
      const config = collection.originalConfig;
      try {
        if (collection.type === 'collection') {
          await axios.put(`/api/v1/collections/${config.id}/settings`, {
            ...config,
            isActive: undefined,
            missing: undefined,
            sortTitleOverride: '',
            groupSortTitleOptIn: false,
          });
        } else {
          await axios.put(`/api/v1/preexisting/${config.id}/settings`, {
            ...config,
            isActive: undefined,
            collectionType: undefined,
            missing: undefined,
            resetSortTitle: true,
          });
        }
        resetCount++;
      } catch (error) {
        addToast(
          intl.formatMessage(messages.errorToast, {
            name: collection.name,
            error: error instanceof Error ? error.message : 'Unknown error',
          }),
          { appearance: 'error', autoDismiss: true }
        );
      }
    }
    setIsSaving(false);
    setResetRound((round) => round + 1);
    if (resetCount > 0) {
      addToast(
        intl.formatMessage(messages.resetSortTitlesToast, {
          count: resetCount,
        }),
        { appearance: 'success', autoDismiss: true }
      );
      onSave();
    }
  };

  const suffixLabels: Record<CollectionSuffixMode, string> = {
    leave: intl.formatMessage(messages.collectionSuffixLeave),
    strip: intl.formatMessage(messages.collectionSuffixStrip),
    add: intl.formatMessage(messages.collectionSuffixAdd),
  };

  // Header order matches the cells in each row. Widths fit every collection, not just the filtered ones, so filtering doesn't shift them.
  const columns = useMemo((): (ColumnFit & { center: boolean })[] => {
    const text = (key: keyof typeof messages) =>
      intl.formatMessage(messages[key]);
    const centered = (
      key: string,
      label: keyof typeof messages,
      cells?: string[]
    ) => ({ key, header: text(label), center: true, cells });
    return [
      {
        key: 'name',
        header: text('collectionName'),
        cells: unifiedCollections.map((c) => c.name),
        min: 192,
        max: 360,
        center: false,
      },
      {
        key: 'library',
        header: text('library'),
        cells: unifiedCollections.map((c) => c.libraryName),
        // Frozen, so kept narrow: longer names truncate with a tooltip.
        max: 128,
        center: false,
      },
      {
        key: 'type',
        header: text('type'),
        cells: ['Agregarr', 'Plex Hub', 'Pre-existing'],
        center: false,
      },
      centered('usersHome', 'usersHome'),
      centered('serverOwnerHome', 'serverOwnerHome'),
      centered('libraryRecommended', 'libraryRecommended'),
      centered('maxItems', 'maxItems'),
      centered('randomizeHomeOrder', 'randomizeHomeOrder'),
      {
        ...centered(
          'sortOrder',
          'sortOrder',
          unifiedCollections.map((c) => c.sortOrder || 'default')
        ),
        max: 128,
      },
      centered(
        'downloadMode',
        'downloadMode',
        unifiedCollections.map((c) => c.downloadMode || '-')
      ),
      centered('searchMissingMovies', 'searchMissingMovies'),
      centered('searchMissingTV', 'searchMissingTV'),
      centered('autoApproveMovies', 'autoApproveMovies'),
      centered('autoApproveTV', 'autoApproveTV'),
      centered('maxSeasonsToRequest', 'maxSeasonsToRequest'),
      centered('seasonsPerShowLimit', 'seasonsPerShowLimit'),
      centered('seasonGrabOrder', 'seasonGrabOrder'),
      centered('maxPositionToProcess', 'maxPositionToProcess'),
      centered('minimumYear', 'minimumYear'),
      centered('minimumImdbRating', 'minimumImdbRating'),
      centered('minimumRottenTomatoesRating', 'minimumRottenTomatoesRating'),
      centered(
        'minimumRottenTomatoesAudienceRating',
        'minimumRottenTomatoesAudienceRating'
      ),
      centered('showUnwatchedOnly', 'showUnwatchedOnly'),
      centered('createPlaceholdersForMissing', 'createPlaceholders'),
      centered(
        'collectionSuffixMode',
        'collectionSuffix',
        unifiedCollections.map((c) =>
          intl.formatMessage(
            suffixCellMessages[c.collectionSuffixMode ?? 'leave']
          )
        )
      ),
    ];
  }, [intl, unifiedCollections]);
  const { widthOf, startResize, nudgeWidth, resetWidths, hasResized } =
    useColumnWidths(columns);
  const editCell =
    'sticky bottom-0 z-20 bg-stone-800 px-3 py-2 shadow-[inset_0_2px_0_rgb(249,115,22)]';
  // The frozen Name and Library columns sit after the 48px checkbox column.
  const libraryLeft = 48 + widthOf('name');

  return (
    <Modal
      title={intl.formatMessage(messages.bulkEditTitle)}
      onCancel={onClose}
      onOk={handleSave}
      okText={
        isSaving
          ? intl.formatMessage(messages.saving)
          : intl.formatMessage(messages.save)
      }
      okDisabled={isSaving || selectedIds.size === 0}
      cancelText={intl.formatMessage(messages.close)}
      backgroundClickable={false}
      customMaxWidth="sm:max-w-[96vw]"
    >
      <div className="space-y-4">
        <p className="text-sm text-gray-400">
          {intl.formatMessage(messages.bulkEditDescription)}
        </p>

        {/* Controls bar */}
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-gray-700 bg-stone-800 p-3">
          <div className="flex items-center gap-3">
            <Button buttonSize="sm" onClick={handleSelectAll}>
              <CheckIcon className="mr-1 h-4 w-4" />
              {intl.formatMessage(messages.selectAll)}
            </Button>
            <Button buttonSize="sm" onClick={handleDeselectAll}>
              <XMarkIcon className="mr-1 h-4 w-4" />
              {intl.formatMessage(messages.deselectAll)}
            </Button>
            <span className="text-sm text-gray-400">
              {intl.formatMessage(messages.selectedCount, {
                count: selectedIds.size,
              })}
            </span>
            {sortTitleResetTargets.length > 0 && !isSaving && (
              <ConfirmButton
                key={resetRound}
                buttonSize="sm"
                buttonType="warning"
                onClick={handleResetSortTitles}
                confirmText={intl.formatMessage(
                  messages.resetSortTitlesConfirm,
                  { count: sortTitleResetTargets.length }
                )}
              >
                {intl.formatMessage(messages.resetSortTitles, {
                  count: sortTitleResetTargets.length,
                })}
              </ConfirmButton>
            )}
          </div>

          <div className="flex items-center gap-3">
            {hasResized && (
              <Button buttonSize="sm" onClick={() => resetWidths()}>
                {intl.formatMessage(messages.resetColumnWidths)}
              </Button>
            )}
            <FunnelIcon className="h-4 w-4 text-gray-400" />

            {/* Type Filter */}
            <select
              value={filterType}
              onChange={(e) => setFilterType(e.target.value)}
              className="rounded-md border border-gray-600 bg-stone-700 px-3 py-1 text-sm text-white focus:border-orange-400 focus:ring-2 focus:ring-orange-400"
            >
              <option value="all">
                {intl.formatMessage(messages.allTypes)}
              </option>
              <option value="agregarr">
                {intl.formatMessage(messages.agregarrCollections)}
              </option>
              <option value="hub">
                {intl.formatMessage(messages.plexHubs)}
              </option>
              <option value="preexisting">
                {intl.formatMessage(messages.preExistingCollections)}
              </option>
            </select>

            {/* Library Filter */}
            <select
              value={filterLibrary}
              onChange={(e) => setFilterLibrary(e.target.value)}
              className="rounded-md border border-gray-600 bg-stone-700 px-3 py-1 text-sm text-white focus:border-orange-400 focus:ring-2 focus:ring-orange-400"
            >
              <option value="all">
                {intl.formatMessage(messages.allLibraries)}
              </option>
              {uniqueLibraries.map((library) => (
                <option key={library} value={library}>
                  {library}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Scrolls inside itself so the headers, the edit row and the horizontal scrollbar stay in view. */}
        <div className="max-h-[calc(100vh-20rem)] min-h-[16rem] overflow-auto rounded-lg border border-gray-700">
          <table
            className="table-fixed"
            style={{
              width: 48 + columns.reduce((sum, c) => sum + widthOf(c.key), 0),
            }}
          >
            <colgroup>
              <col style={{ width: 48 }} />
              {columns.map((column) => (
                <col key={column.key} style={{ width: widthOf(column.key) }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                <th className="sticky left-0 top-0 z-30 bg-stone-800 px-3 py-2 text-left text-xs font-medium text-gray-400 shadow-[inset_0_-1px_0_rgb(55,65,81),2px_0_4px_rgba(0,0,0,0.3)]">
                  <input
                    type="checkbox"
                    checked={
                      selectedIds.size === filteredAndSortedCollections.length
                    }
                    onChange={() => {
                      if (
                        selectedIds.size === filteredAndSortedCollections.length
                      ) {
                        handleDeselectAll();
                      } else {
                        handleSelectAll();
                      }
                    }}
                    className="h-4 w-4 rounded border-gray-600 bg-stone-700 text-orange-500 focus:ring-orange-500"
                  />
                </th>
                {columns.map((column) => (
                  <th
                    key={column.key}
                    className={`sticky top-0 cursor-pointer select-none bg-stone-800 px-3 py-2 text-xs font-medium text-gray-400 hover:text-gray-300 ${
                      column.center ? 'text-center' : 'text-left'
                    } ${
                      column.key === 'name'
                        ? 'left-12 z-30 shadow-[inset_0_-1px_0_rgb(55,65,81),2px_0_4px_rgba(0,0,0,0.3)]'
                        : column.key === 'library'
                        ? 'z-30 shadow-[inset_0_-1px_0_rgb(55,65,81),2px_0_0_0_rgb(75,85,99)]'
                        : 'z-20 shadow-[inset_0_-1px_0_rgb(55,65,81)]'
                    }`}
                    style={
                      column.key === 'library'
                        ? { left: libraryLeft }
                        : undefined
                    }
                    onClick={() => handleColumnSort(column.key)}
                  >
                    {column.header}
                    {renderSortIndicator(column.key)}
                    <button
                      type="button"
                      aria-label={intl.formatMessage(messages.resizeColumn)}
                      title={intl.formatMessage(messages.resizeColumn)}
                      onPointerDown={startResize(column.key, column.min)}
                      onDoubleClick={() => resetWidths(column.key)}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                          e.preventDefault();
                          nudgeWidth(
                            column.key,
                            e.key === 'ArrowLeft' ? -16 : 16,
                            column.min
                          );
                        }
                      }}
                      className="group absolute -right-1 top-0 z-10 flex h-full w-2.5 cursor-col-resize touch-none justify-center focus:outline-none"
                    >
                      {/* Always-visible divider, so columns read as resizable */}
                      <span className="h-full w-px bg-gray-600 group-hover:w-1 group-hover:bg-orange-500 group-focus:w-1 group-focus:bg-orange-500" />
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredAndSortedCollections.length === 0 ? (
                <tr>
                  <td
                    colSpan={columns.length + 1}
                    className="px-3 py-8 text-center text-sm text-gray-500"
                  >
                    {intl.formatMessage(messages.noCollections)}
                  </td>
                </tr>
              ) : (
                <>
                  {/* Data rows */}
                  {filteredAndSortedCollections.map((collection) => (
                    <tr
                      key={collection.id}
                      className={`group border-b border-gray-800 transition-colors hover:bg-stone-800/50 ${
                        selectedIds.has(collection.id) ? 'bg-stone-800/30' : ''
                      }`}
                    >
                      <td
                        className={`sticky left-0 z-10 px-3 py-2 transition-colors ${
                          selectedIds.has(collection.id)
                            ? 'bg-stone-800/30 group-hover:bg-stone-800/40'
                            : 'bg-stone-800 group-hover:bg-stone-700'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={selectedIds.has(collection.id)}
                          onChange={() => toggleSelection(collection.id)}
                          className="h-4 w-4 rounded border-gray-600 bg-stone-700 text-orange-500 focus:ring-orange-500"
                        />
                      </td>
                      <td
                        title={collection.name}
                        className={`sticky left-12 z-10 truncate px-3 py-2 text-sm text-white transition-colors ${
                          selectedIds.has(collection.id)
                            ? 'bg-stone-800/30 group-hover:bg-stone-800/40'
                            : 'bg-stone-800 group-hover:bg-stone-700'
                        }`}
                      >
                        {collection.name}
                        {collection.membership && (
                          <div className="mt-1">
                            <RotationBadge
                              membership={collection.membership}
                              hideState
                            />
                          </div>
                        )}
                      </td>
                      <td
                        title={collection.libraryName}
                        style={{ left: libraryLeft }}
                        className={`sticky z-10 truncate px-3 py-2 text-sm text-gray-400 shadow-[2px_0_0_0_rgb(75,85,99)] transition-colors ${
                          selectedIds.has(collection.id)
                            ? 'bg-stone-800/30 group-hover:bg-stone-800/40'
                            : 'bg-stone-800 group-hover:bg-stone-700'
                        }`}
                      >
                        {collection.libraryName}
                      </td>
                      <td className="truncate px-3 py-2 text-sm text-gray-400">
                        {collection.type === 'collection'
                          ? 'Agregarr'
                          : collection.type === 'hub'
                          ? 'Plex Hub'
                          : 'Pre-existing'}
                      </td>
                      <td
                        className={`px-3 py-2 text-center ${
                          !isFieldApplicable('usersHome', collection.type)
                            ? 'opacity-30'
                            : ''
                        }`}
                      >
                        <CheckIcon
                          className={`mx-auto h-4 w-4 ${
                            collection.visibilityConfig.usersHome
                              ? 'text-green-500'
                              : 'text-gray-600'
                          }`}
                        />
                      </td>
                      <td
                        className={`px-3 py-2 text-center ${
                          !isFieldApplicable('serverOwnerHome', collection.type)
                            ? 'opacity-30'
                            : ''
                        }`}
                      >
                        <CheckIcon
                          className={`mx-auto h-4 w-4 ${
                            collection.visibilityConfig.serverOwnerHome
                              ? 'text-green-500'
                              : 'text-gray-600'
                          }`}
                        />
                      </td>
                      <td
                        className={`px-3 py-2 text-center ${
                          !isFieldApplicable(
                            'libraryRecommended',
                            collection.type
                          )
                            ? 'opacity-30'
                            : ''
                        }`}
                      >
                        <CheckIcon
                          className={`mx-auto h-4 w-4 ${
                            collection.visibilityConfig.libraryRecommended
                              ? 'text-green-500'
                              : 'text-gray-600'
                          }`}
                        />
                      </td>
                      <td
                        className={`px-3 py-2 text-center text-sm ${
                          !isFieldApplicable('maxItems', collection.type)
                            ? 'text-gray-600 opacity-30'
                            : 'text-gray-300'
                        }`}
                      >
                        {collection.maxItems || '-'}
                      </td>
                      <td
                        className={`px-3 py-2 text-center ${
                          !isFieldApplicable(
                            'randomizeHomeOrder',
                            collection.type
                          )
                            ? 'opacity-30'
                            : ''
                        }`}
                      >
                        <CheckIcon
                          className={`mx-auto h-4 w-4 ${
                            collection.randomizeHomeOrder
                              ? 'text-green-500'
                              : 'text-gray-600'
                          }`}
                        />
                      </td>
                      <td
                        title={collection.sortOrder || 'default'}
                        className={`truncate px-3 py-2 text-center text-sm ${
                          !isFieldApplicable('sortOrder', collection.type)
                            ? 'text-gray-600 opacity-30'
                            : 'text-gray-300'
                        }`}
                      >
                        {collection.sortOrder || 'default'}
                      </td>
                      <td
                        className={`px-3 py-2 text-center text-sm ${
                          !isFieldApplicable('downloadMode', collection.type)
                            ? 'text-gray-600 opacity-30'
                            : 'text-gray-300'
                        }`}
                      >
                        {collection.downloadMode || '-'}
                      </td>
                      <td
                        className={`px-3 py-2 text-center ${
                          !isFieldApplicable(
                            'searchMissingMovies',
                            collection.type
                          )
                            ? 'opacity-30'
                            : ''
                        }`}
                      >
                        <CheckIcon
                          className={`mx-auto h-4 w-4 ${
                            collection.searchMissingMovies
                              ? 'text-green-500'
                              : 'text-gray-600'
                          }`}
                        />
                      </td>
                      <td
                        className={`px-3 py-2 text-center ${
                          !isFieldApplicable('searchMissingTV', collection.type)
                            ? 'opacity-30'
                            : ''
                        }`}
                      >
                        <CheckIcon
                          className={`mx-auto h-4 w-4 ${
                            collection.searchMissingTV
                              ? 'text-green-500'
                              : 'text-gray-600'
                          }`}
                        />
                      </td>
                      <td
                        className={`px-3 py-2 text-center ${
                          !isFieldApplicable(
                            'autoApproveMovies',
                            collection.type
                          )
                            ? 'opacity-30'
                            : ''
                        }`}
                      >
                        <CheckIcon
                          className={`mx-auto h-4 w-4 ${
                            collection.autoApproveMovies
                              ? 'text-green-500'
                              : 'text-gray-600'
                          }`}
                        />
                      </td>
                      <td
                        className={`px-3 py-2 text-center ${
                          !isFieldApplicable('autoApproveTV', collection.type)
                            ? 'opacity-30'
                            : ''
                        }`}
                      >
                        <CheckIcon
                          className={`mx-auto h-4 w-4 ${
                            collection.autoApproveTV
                              ? 'text-green-500'
                              : 'text-gray-600'
                          }`}
                        />
                      </td>
                      <td
                        className={`px-3 py-2 text-center text-sm ${
                          !isFieldApplicable(
                            'maxSeasonsToRequest',
                            collection.type
                          )
                            ? 'text-gray-600 opacity-30'
                            : 'text-gray-300'
                        }`}
                      >
                        {collection.maxSeasonsToRequest || '-'}
                      </td>
                      <td
                        className={`px-3 py-2 text-center text-sm ${
                          !isFieldApplicable(
                            'seasonsPerShowLimit',
                            collection.type
                          )
                            ? 'text-gray-600 opacity-30'
                            : 'text-gray-300'
                        }`}
                      >
                        {collection.seasonsPerShowLimit || '-'}
                      </td>
                      <td
                        className={`px-3 py-2 text-center text-sm ${
                          !isFieldApplicable('seasonGrabOrder', collection.type)
                            ? 'text-gray-600 opacity-30'
                            : 'text-gray-300'
                        }`}
                      >
                        {collection.seasonGrabOrder
                          ? collection.seasonGrabOrder.charAt(0).toUpperCase() +
                            collection.seasonGrabOrder.slice(1)
                          : '-'}
                      </td>
                      <td
                        className={`px-3 py-2 text-center text-sm ${
                          !isFieldApplicable(
                            'maxPositionToProcess',
                            collection.type
                          )
                            ? 'text-gray-600 opacity-30'
                            : 'text-gray-300'
                        }`}
                      >
                        {collection.maxPositionToProcess || '-'}
                      </td>
                      <td
                        className={`px-3 py-2 text-center text-sm ${
                          !isFieldApplicable('minimumYear', collection.type)
                            ? 'text-gray-600 opacity-30'
                            : 'text-gray-300'
                        }`}
                      >
                        {collection.minimumYear || '-'}
                      </td>
                      <td
                        className={`px-3 py-2 text-center text-sm ${
                          !isFieldApplicable(
                            'minimumImdbRating',
                            collection.type
                          )
                            ? 'text-gray-600 opacity-30'
                            : 'text-gray-300'
                        }`}
                      >
                        {collection.minimumImdbRating || '-'}
                      </td>
                      <td
                        className={`px-3 py-2 text-center text-sm ${
                          !isFieldApplicable(
                            'minimumRottenTomatoesRating',
                            collection.type
                          )
                            ? 'text-gray-600 opacity-30'
                            : 'text-gray-300'
                        }`}
                      >
                        {collection.minimumRottenTomatoesRating || '-'}
                      </td>
                      <td
                        className={`px-3 py-2 text-center text-sm ${
                          !isFieldApplicable(
                            'minimumRottenTomatoesAudienceRating',
                            collection.type
                          )
                            ? 'text-gray-600 opacity-30'
                            : 'text-gray-300'
                        }`}
                      >
                        {collection.minimumRottenTomatoesAudienceRating || '-'}
                      </td>
                      <td
                        className={`px-3 py-2 text-center ${
                          !isFieldApplicable(
                            'showUnwatchedOnly',
                            collection.type
                          )
                            ? 'opacity-30'
                            : ''
                        }`}
                      >
                        <CheckIcon
                          className={`mx-auto h-4 w-4 ${
                            collection.showUnwatchedOnly
                              ? 'text-green-500'
                              : 'text-gray-600'
                          }`}
                        />
                      </td>
                      <td
                        className={`px-3 py-2 text-center ${
                          !isFieldApplicable(
                            'createPlaceholdersForMissing',
                            collection.type
                          )
                            ? 'opacity-30'
                            : ''
                        }`}
                      >
                        <CheckIcon
                          className={`mx-auto h-4 w-4 ${
                            collection.createPlaceholdersForMissing
                              ? 'text-green-500'
                              : 'text-gray-600'
                          }`}
                        />
                      </td>
                      <td
                        className={`truncate px-3 py-2 text-center text-sm ${
                          !isFieldApplicable(
                            'collectionSuffixMode',
                            collection.type
                          )
                            ? 'text-gray-600 opacity-30'
                            : 'text-gray-300'
                        }`}
                      >
                        {isFieldApplicable(
                          'collectionSuffixMode',
                          collection.type
                        )
                          ? intl.formatMessage(
                              suffixCellMessages[
                                collection.collectionSuffixMode ?? 'leave'
                              ]
                            )
                          : '-'}
                      </td>
                    </tr>
                  ))}

                  {/* Edit row: its cells stick to the bottom, above the horizontal scrollbar */}
                  <tr>
                    <td
                      className="sticky bottom-0 left-0 z-30 bg-stone-800 px-3 py-3 shadow-[inset_0_2px_0_rgb(249,115,22),2px_0_0_0_rgb(75,85,99)]"
                      colSpan={3}
                    >
                      <div className="text-xs font-medium text-orange-400">
                        {intl.formatMessage(messages.editValues)}
                      </div>
                    </td>
                    <td className={editCell}></td>
                    <td className={editCell}>
                      <select
                        value={
                          editValues.visibilityConfig?.usersHome === undefined
                            ? ''
                            : editValues.visibilityConfig.usersHome
                            ? 'true'
                            : 'false'
                        }
                        onChange={(e) =>
                          setEditValues({
                            ...editValues,
                            visibilityConfig: {
                              ...editValues.visibilityConfig,
                              usersHome:
                                e.target.value === ''
                                  ? undefined
                                  : e.target.value === 'true',
                            },
                          })
                        }
                        className="w-full rounded border border-gray-600 bg-stone-700 px-2 py-1 text-xs text-white"
                      >
                        <option value="">-</option>
                        <option value="true">
                          {intl.formatMessage(messages.yes)}
                        </option>
                        <option value="false">
                          {intl.formatMessage(messages.no)}
                        </option>
                      </select>
                    </td>
                    <td className={editCell}>
                      <select
                        value={
                          editValues.visibilityConfig?.serverOwnerHome ===
                          undefined
                            ? ''
                            : editValues.visibilityConfig.serverOwnerHome
                            ? 'true'
                            : 'false'
                        }
                        onChange={(e) =>
                          setEditValues({
                            ...editValues,
                            visibilityConfig: {
                              ...editValues.visibilityConfig,
                              serverOwnerHome:
                                e.target.value === ''
                                  ? undefined
                                  : e.target.value === 'true',
                            },
                          })
                        }
                        className="w-full rounded border border-gray-600 bg-stone-700 px-2 py-1 text-xs text-white"
                      >
                        <option value="">-</option>
                        <option value="true">
                          {intl.formatMessage(messages.yes)}
                        </option>
                        <option value="false">
                          {intl.formatMessage(messages.no)}
                        </option>
                      </select>
                    </td>
                    <td className={editCell}>
                      <select
                        value={
                          editValues.visibilityConfig?.libraryRecommended ===
                          undefined
                            ? ''
                            : editValues.visibilityConfig.libraryRecommended
                            ? 'true'
                            : 'false'
                        }
                        onChange={(e) =>
                          setEditValues({
                            ...editValues,
                            visibilityConfig: {
                              ...editValues.visibilityConfig,
                              libraryRecommended:
                                e.target.value === ''
                                  ? undefined
                                  : e.target.value === 'true',
                            },
                          })
                        }
                        className="w-full rounded border border-gray-600 bg-stone-700 px-2 py-1 text-xs text-white"
                      >
                        <option value="">-</option>
                        <option value="true">
                          {intl.formatMessage(messages.yes)}
                        </option>
                        <option value="false">
                          {intl.formatMessage(messages.no)}
                        </option>
                      </select>
                    </td>
                    <td className={editCell}>
                      <input
                        type="number"
                        value={editValues.maxItems || ''}
                        onChange={(e) =>
                          setEditValues({
                            ...editValues,
                            maxItems:
                              e.target.value === ''
                                ? ''
                                : Number(e.target.value),
                          })
                        }
                        placeholder="-"
                        className="w-full rounded border border-gray-600 bg-stone-700 px-2 py-1 text-xs text-white"
                        min={1}
                      />
                    </td>
                    <td className={editCell}>
                      <select
                        value={
                          editValues.randomizeHomeOrder === undefined
                            ? ''
                            : editValues.randomizeHomeOrder
                            ? 'true'
                            : 'false'
                        }
                        onChange={(e) =>
                          setEditValues({
                            ...editValues,
                            randomizeHomeOrder:
                              e.target.value === ''
                                ? undefined
                                : e.target.value === 'true',
                          })
                        }
                        className="w-full rounded border border-gray-600 bg-stone-700 px-2 py-1 text-xs text-white"
                      >
                        <option value="">-</option>
                        <option value="true">
                          {intl.formatMessage(messages.yes)}
                        </option>
                        <option value="false">
                          {intl.formatMessage(messages.no)}
                        </option>
                      </select>
                    </td>
                    <td className={editCell}>
                      <select
                        value={editValues.sortOrder || ''}
                        onChange={(e) =>
                          setEditValues({
                            ...editValues,
                            sortOrder:
                              e.target.value === ''
                                ? undefined
                                : (e.target.value as CollectionSortOrder),
                          })
                        }
                        className="w-full rounded border border-gray-600 bg-stone-700 px-2 py-1 text-xs text-white"
                      >
                        <option value="">-</option>
                        <option value="default">
                          {intl.formatMessage(messages.defaultSort)}
                        </option>
                        <option value="reverse">
                          {intl.formatMessage(messages.reverseSort)}
                        </option>
                        <option value="random">
                          {intl.formatMessage(messages.randomSort)}
                        </option>
                        <option value="imdb_rating_desc">IMDb ↓</option>
                        <option value="imdb_rating_asc">IMDb ↑</option>
                      </select>
                    </td>
                    <td className={editCell}>
                      <select
                        value={editValues.downloadMode || ''}
                        onChange={(e) =>
                          setEditValues({
                            ...editValues,
                            downloadMode:
                              e.target.value === ''
                                ? undefined
                                : (e.target.value as 'overseerr' | 'direct'),
                          })
                        }
                        className="w-full rounded border border-gray-600 bg-stone-700 px-2 py-1 text-xs text-white"
                      >
                        <option value="">-</option>
                        <option value="overseerr">
                          {intl.formatMessage(messages.overseerrMode)}
                        </option>
                        <option value="direct">
                          {intl.formatMessage(messages.directMode)}
                        </option>
                      </select>
                    </td>
                    <td className={editCell}>
                      <select
                        value={
                          editValues.searchMissingMovies === undefined
                            ? ''
                            : editValues.searchMissingMovies
                            ? 'true'
                            : 'false'
                        }
                        onChange={(e) =>
                          setEditValues({
                            ...editValues,
                            searchMissingMovies:
                              e.target.value === ''
                                ? undefined
                                : e.target.value === 'true',
                          })
                        }
                        className="w-full rounded border border-gray-600 bg-stone-700 px-2 py-1 text-xs text-white"
                      >
                        <option value="">-</option>
                        <option value="true">
                          {intl.formatMessage(messages.yes)}
                        </option>
                        <option value="false">
                          {intl.formatMessage(messages.no)}
                        </option>
                      </select>
                    </td>
                    <td className={editCell}>
                      <select
                        value={
                          editValues.searchMissingTV === undefined
                            ? ''
                            : editValues.searchMissingTV
                            ? 'true'
                            : 'false'
                        }
                        onChange={(e) =>
                          setEditValues({
                            ...editValues,
                            searchMissingTV:
                              e.target.value === ''
                                ? undefined
                                : e.target.value === 'true',
                          })
                        }
                        className="w-full rounded border border-gray-600 bg-stone-700 px-2 py-1 text-xs text-white"
                      >
                        <option value="">-</option>
                        <option value="true">
                          {intl.formatMessage(messages.yes)}
                        </option>
                        <option value="false">
                          {intl.formatMessage(messages.no)}
                        </option>
                      </select>
                    </td>
                    <td className={editCell}>
                      <select
                        value={
                          editValues.autoApproveMovies === undefined
                            ? ''
                            : editValues.autoApproveMovies
                            ? 'true'
                            : 'false'
                        }
                        onChange={(e) =>
                          setEditValues({
                            ...editValues,
                            autoApproveMovies:
                              e.target.value === ''
                                ? undefined
                                : e.target.value === 'true',
                          })
                        }
                        className="w-full rounded border border-gray-600 bg-stone-700 px-2 py-1 text-xs text-white"
                      >
                        <option value="">-</option>
                        <option value="true">
                          {intl.formatMessage(messages.yes)}
                        </option>
                        <option value="false">
                          {intl.formatMessage(messages.no)}
                        </option>
                      </select>
                    </td>
                    <td className={editCell}>
                      <select
                        value={
                          editValues.autoApproveTV === undefined
                            ? ''
                            : editValues.autoApproveTV
                            ? 'true'
                            : 'false'
                        }
                        onChange={(e) =>
                          setEditValues({
                            ...editValues,
                            autoApproveTV:
                              e.target.value === ''
                                ? undefined
                                : e.target.value === 'true',
                          })
                        }
                        className="w-full rounded border border-gray-600 bg-stone-700 px-2 py-1 text-xs text-white"
                      >
                        <option value="">-</option>
                        <option value="true">
                          {intl.formatMessage(messages.yes)}
                        </option>
                        <option value="false">
                          {intl.formatMessage(messages.no)}
                        </option>
                      </select>
                    </td>
                    <td className={editCell}>
                      <input
                        type="number"
                        value={editValues.maxSeasonsToRequest || ''}
                        onChange={(e) =>
                          setEditValues({
                            ...editValues,
                            maxSeasonsToRequest:
                              e.target.value === ''
                                ? ''
                                : Number(e.target.value),
                          })
                        }
                        placeholder="-"
                        className="w-full rounded border border-gray-600 bg-stone-700 px-2 py-1 text-xs text-white"
                        min={0}
                      />
                    </td>
                    <td className={editCell}>
                      <input
                        type="number"
                        value={editValues.seasonsPerShowLimit || ''}
                        onChange={(e) =>
                          setEditValues({
                            ...editValues,
                            seasonsPerShowLimit:
                              e.target.value === ''
                                ? ''
                                : Number(e.target.value),
                          })
                        }
                        placeholder="-"
                        className="w-full rounded border border-gray-600 bg-stone-700 px-2 py-1 text-xs text-white"
                        min={0}
                      />
                    </td>
                    <td className={editCell}>
                      <select
                        value={editValues.seasonGrabOrder || ''}
                        onChange={(e) =>
                          setEditValues({
                            ...editValues,
                            seasonGrabOrder: e.target.value as
                              | 'first'
                              | 'latest'
                              | 'airing'
                              | '',
                          })
                        }
                        className="w-full rounded border border-gray-600 bg-stone-700 px-2 py-1 text-xs text-white"
                      >
                        <option value="">-</option>
                        <option value="first">
                          {intl.formatMessage(messages.firstSeason)}
                        </option>
                        <option value="latest">
                          {intl.formatMessage(messages.latestSeason)}
                        </option>
                        <option value="airing">
                          {intl.formatMessage(messages.airingSeason)}
                        </option>
                      </select>
                    </td>
                    <td className={editCell}>
                      <input
                        type="number"
                        value={editValues.maxPositionToProcess || ''}
                        onChange={(e) =>
                          setEditValues({
                            ...editValues,
                            maxPositionToProcess:
                              e.target.value === ''
                                ? ''
                                : Number(e.target.value),
                          })
                        }
                        placeholder="-"
                        className="w-full rounded border border-gray-600 bg-stone-700 px-2 py-1 text-xs text-white"
                        min={0}
                      />
                    </td>
                    <td className={editCell}>
                      <input
                        type="number"
                        value={editValues.minimumYear || ''}
                        onChange={(e) =>
                          setEditValues({
                            ...editValues,
                            minimumYear:
                              e.target.value === ''
                                ? ''
                                : Number(e.target.value),
                          })
                        }
                        placeholder="-"
                        className="w-full rounded border border-gray-600 bg-stone-700 px-2 py-1 text-xs text-white"
                        min={1900}
                        max={2100}
                      />
                    </td>
                    <td className={editCell}>
                      <input
                        type="number"
                        value={editValues.minimumImdbRating || ''}
                        onChange={(e) =>
                          setEditValues({
                            ...editValues,
                            minimumImdbRating:
                              e.target.value === ''
                                ? ''
                                : Number(e.target.value),
                          })
                        }
                        placeholder="-"
                        className="w-full rounded border border-gray-600 bg-stone-700 px-2 py-1 text-xs text-white"
                        min={0}
                        max={10}
                        step={0.1}
                      />
                    </td>
                    <td className={editCell}>
                      <input
                        type="number"
                        value={editValues.minimumRottenTomatoesRating || ''}
                        onChange={(e) =>
                          setEditValues({
                            ...editValues,
                            minimumRottenTomatoesRating:
                              e.target.value === ''
                                ? ''
                                : Number(e.target.value),
                          })
                        }
                        placeholder="-"
                        className="w-full rounded border border-gray-600 bg-stone-700 px-2 py-1 text-xs text-white"
                        min={0}
                        max={100}
                      />
                    </td>
                    <td className={editCell}>
                      <input
                        type="number"
                        value={
                          editValues.minimumRottenTomatoesAudienceRating || ''
                        }
                        onChange={(e) =>
                          setEditValues({
                            ...editValues,
                            minimumRottenTomatoesAudienceRating:
                              e.target.value === ''
                                ? ''
                                : Number(e.target.value),
                          })
                        }
                        placeholder="-"
                        className="w-full rounded border border-gray-600 bg-stone-700 px-2 py-1 text-xs text-white"
                        min={0}
                        max={100}
                      />
                    </td>
                    <td className={editCell}>
                      <select
                        value={
                          editValues.showUnwatchedOnly === undefined
                            ? ''
                            : editValues.showUnwatchedOnly
                            ? 'true'
                            : 'false'
                        }
                        onChange={(e) =>
                          setEditValues({
                            ...editValues,
                            showUnwatchedOnly:
                              e.target.value === ''
                                ? undefined
                                : e.target.value === 'true',
                          })
                        }
                        className="w-full rounded border border-gray-600 bg-stone-700 px-2 py-1 text-xs text-white"
                      >
                        <option value="">-</option>
                        <option value="true">
                          {intl.formatMessage(messages.yes)}
                        </option>
                        <option value="false">
                          {intl.formatMessage(messages.no)}
                        </option>
                      </select>
                    </td>
                    <td className={editCell}>
                      <select
                        value={
                          editValues.createPlaceholdersForMissing === undefined
                            ? ''
                            : editValues.createPlaceholdersForMissing
                            ? 'true'
                            : 'false'
                        }
                        onChange={(e) =>
                          setEditValues({
                            ...editValues,
                            createPlaceholdersForMissing:
                              e.target.value === ''
                                ? undefined
                                : e.target.value === 'true',
                          })
                        }
                        className="w-full rounded border border-gray-600 bg-stone-700 px-2 py-1 text-xs text-white"
                      >
                        <option value="">-</option>
                        <option value="true">
                          {intl.formatMessage(messages.yes)}
                        </option>
                        <option value="false">
                          {intl.formatMessage(messages.no)}
                        </option>
                      </select>
                    </td>
                    <td className={editCell}>
                      <select
                        value={editValues.collectionSuffixMode || ''}
                        onChange={(e) =>
                          setEditValues({
                            ...editValues,
                            collectionSuffixMode: e.target.value as
                              | CollectionSuffixMode
                              | '',
                          })
                        }
                        className="w-full rounded border border-gray-600 bg-stone-700 px-2 py-1 text-xs text-white"
                      >
                        <option value="">-</option>
                        {(['leave', 'strip', 'add'] as const).map((mode) => (
                          <option key={mode} value={mode}>
                            {suffixLabels[mode]}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                </>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </Modal>
  );
};

export default BulkEditModal;
